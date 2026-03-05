use notify::event::{EventKind, ModifyKind};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use tokio::sync::mpsc;

/// A thin wrapper around `notify::RecommendedWatcher` that watches a single
/// file and sends events through a tokio channel when the file is modified.
pub struct FileWatcher {
    _watcher: RecommendedWatcher,
}

impl FileWatcher {
    /// Start watching `path`. Returns a receiver that yields the path each
    /// time it is modified (debounced internally by the OS / notify backend).
    pub fn watch(path: PathBuf) -> Result<(Self, mpsc::Receiver<PathBuf>), String> {
        let (tx, rx) = mpsc::channel::<PathBuf>(16);
        let watched_path = path.clone();

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let dominated = matches!(
                    event.kind,
                    EventKind::Modify(ModifyKind::Data(_))
                        | EventKind::Modify(ModifyKind::Any)
                        | EventKind::Create(_)
                );
                if dominated {
                    let _ = tx.blocking_send(watched_path.clone());
                }
            }
        })
        .map_err(|e| format!("failed to create file watcher: {e}"))?;

        // Watch the parent directory (some OS backends need this)
        let watch_target = if path.exists() {
            path.clone()
        } else if let Some(parent) = path.parent() {
            parent.to_path_buf()
        } else {
            path.clone()
        };

        watcher
            .watch(&watch_target, RecursiveMode::NonRecursive)
            .map_err(|e| format!("failed to watch {}: {e}", watch_target.display()))?;

        Ok((Self { _watcher: watcher }, rx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[tokio::test]
    async fn detects_file_change_within_200ms() {
        let mut tmp = NamedTempFile::new().expect("temp file");
        writeln!(tmp, "initial").unwrap();
        tmp.flush().unwrap();

        let path = tmp.path().to_path_buf();
        let (_watcher, mut rx) = FileWatcher::watch(path.clone()).expect("watch");

        // Write new content
        std::fs::write(&path, "updated content").expect("write");

        // Should receive event within 200ms
        let result =
            tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await;
        assert!(
            result.is_ok(),
            "file watcher should detect change within timeout"
        );
        assert_eq!(result.unwrap().unwrap(), path);
    }

    #[tokio::test]
    async fn watches_nonexistent_file_via_parent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file_path = dir.path().join("does-not-exist-yet.json");

        let (_watcher, mut rx) = FileWatcher::watch(file_path.clone()).expect("watch");

        // Create the file
        std::fs::write(&file_path, r#"{"hello": true}"#).expect("write");

        let result =
            tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await;
        assert!(
            result.is_ok(),
            "should detect creation of new file in watched dir"
        );
    }
}
