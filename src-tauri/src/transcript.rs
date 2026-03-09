use crate::metrics::MetricUpdate;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;

const MAX_ACTIVE_TOOLS: usize = 20;

/// Permission-requiring tools that need explicit user approval.
const PERMISSION_TOOLS: &[&str] = &["Edit", "Write", "Bash", "MultiEdit"];

/// Sub-agent tool names.
const AGENT_TOOLS: &[&str] = &["Task", "Agent"];

pub struct TranscriptWatcher {
    path: PathBuf,
    file: Option<std::fs::File>,
    offset: u64,
    active_tools: VecDeque<String>,
    active_agents: Vec<String>,
    pending_permissions: bool,
    initialized: bool,
    /// tool_use ids that are waiting for a tool_result (pending permission)
    pending_tool_ids: Vec<String>,
    /// count of permission-requiring tools with no id (cannot be cleared by tool_result)
    anonymous_pending_count: u32,
}

impl TranscriptWatcher {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            file: None,
            offset: 0,
            active_tools: VecDeque::new(),
            active_agents: Vec::new(),
            pending_permissions: false,
            initialized: false,
            pending_tool_ids: Vec::new(),
            anonymous_pending_count: 0,
        }
    }

    /// Open (or re-open) the file. On first open, seek to end so we only see new events.
    fn ensure_open(&mut self) -> bool {
        if self.file.is_some() {
            return true;
        }

        match std::fs::File::open(&self.path) {
            Ok(mut f) => {
                if !self.initialized {
                    // Seek to end — only read new lines going forward
                    if let Ok(end) = f.seek(SeekFrom::End(0)) {
                        self.offset = end;
                    }
                    self.initialized = true;
                } else {
                    // Re-opening after a close: seek to saved offset
                    let _ = f.seek(SeekFrom::Start(self.offset));
                }
                self.file = Some(f);
                true
            }
            Err(_) => false,
        }
    }

    /// Read all new lines from the file and return a consolidated MetricUpdate if anything changed.
    pub fn poll(&mut self) -> Option<MetricUpdate> {
        if !self.ensure_open() {
            return None;
        }

        // Detect file truncation/rotation: if file is shorter than our saved offset,
        // the file was replaced. Reset and reopen from the beginning.
        if let Some(ref file) = self.file {
            if let Ok(metadata) = file.metadata() {
                if metadata.len() < self.offset {
                    self.offset = 0;
                    self.file = None;
                    self.initialized = false;
                    if !self.ensure_open() {
                        return None;
                    }
                }
            }
        }

        // Collect new lines first (bounded borrow of self.file), then process them.
        let (collected, errored) = {
            let file = self.file.as_mut()?;
            let _ = file.seek(SeekFrom::Start(self.offset));
            let mut reader = BufReader::new(&*file);
            let mut lines: Vec<String> = Vec::new();
            let mut hit_error = false;

            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(n) => {
                        self.offset += n as u64;
                        lines.push(line);
                    }
                    Err(_) => {
                        hit_error = true;
                        break;
                    }
                }
            }
            (lines, hit_error)
        };

        if errored {
            self.file = None;
        }

        let mut lines_processed = 0usize;
        for line in &collected {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                self.process_line(trimmed);
                lines_processed += 1;
            }
        }

        if lines_processed == 0 {
            return None;
        }

        Some(self.build_update())
    }

    fn process_line(&mut self, line: &str) {
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return,
        };

        // Each transcript line may be a message object with a "content" array,
        // or a bare content block. Handle both.
        self.process_value(&val);
    }

    fn process_value(&mut self, val: &serde_json::Value) {
        match val {
            serde_json::Value::Object(map) => {
                // Check if this object itself is a tool_use block
                if map.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    self.handle_tool_use(map);
                    return;
                }

                // Check if this object itself is a tool_result block
                if map.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                    self.handle_tool_result(map);
                    return;
                }

                // Recurse into "content" array if present (message wrapper)
                if let Some(content) = map.get("content") {
                    self.process_value(content);
                }

                // Also recurse into "message" if present
                if let Some(message) = map.get("message") {
                    self.process_value(message);
                }
            }
            serde_json::Value::Array(arr) => {
                for item in arr {
                    self.process_value(item);
                }
            }
            _ => {}
        }
    }

    fn handle_tool_use(&mut self, map: &serde_json::Map<String, serde_json::Value>) {
        let name = match map.get("name").and_then(|n| n.as_str()) {
            Some(n) => n.to_string(),
            None => return,
        };

        let tool_id = map
            .get("id")
            .and_then(|id| id.as_str())
            .map(|s| s.to_string());

        // Add to active_tools (bounded deque)
        if !self.active_tools.iter().any(|t| t == &name) {
            if self.active_tools.len() >= MAX_ACTIVE_TOOLS {
                self.active_tools.pop_front();
            }
            self.active_tools.push_back(name.clone());
        }

        // Track sub-agents
        if AGENT_TOOLS.contains(&name.as_str()) && !self.active_agents.contains(&name) {
            self.active_agents.push(name.clone());
        }

        // Track permission-requiring tools: mark pending if no result yet
        if PERMISSION_TOOLS.contains(&name.as_str()) {
            if let Some(id) = tool_id {
                if !self.pending_tool_ids.contains(&id) {
                    self.pending_tool_ids.push(id);
                }
            } else {
                // No id available, mark pending conservatively
                self.anonymous_pending_count += 1;
            }
        }

        // Recompute pending_permissions
        self.pending_permissions =
            self.anonymous_pending_count > 0 || !self.pending_tool_ids.is_empty();
    }

    fn handle_tool_result(&mut self, map: &serde_json::Map<String, serde_json::Value>) {
        let tool_use_id = map
            .get("tool_use_id")
            .and_then(|id| id.as_str())
            .map(|s| s.to_string());

        match tool_use_id {
            Some(id) => {
                let before = self.pending_tool_ids.len();
                self.pending_tool_ids.retain(|pending| pending != &id);
                // If no named id was cleared and we have anonymous pending, decrement one
                if self.pending_tool_ids.len() == before && self.anonymous_pending_count > 0 {
                    self.anonymous_pending_count -= 1;
                }
            }
            None => {
                // No tool_use_id: clear one anonymous pending if any
                if self.anonymous_pending_count > 0 {
                    self.anonymous_pending_count -= 1;
                }
            }
        }

        self.pending_permissions =
            self.anonymous_pending_count > 0 || !self.pending_tool_ids.is_empty();
    }

    fn build_update(&self) -> MetricUpdate {
        MetricUpdate {
            active_tools: self.active_tools.iter().cloned().collect(),
            model: None,
            tokens_in: None,
            tokens_out: None,
            cost: None,
            context_used: None,
            context_total: None,
            status: None,
            rate_limit_seconds: None,
            source: Some("transcript".to_string()),
            active_agents: self.active_agents.clone(),
            pending_permissions: Some(self.pending_permissions),
        }
    }
}

/// Scan `~/.claude/projects/` for the most recently modified `.jsonl` file
/// whose modification time falls within `session_start..session_start+60s`.
pub fn discover_transcript_path(
    session_start: std::time::SystemTime,
) -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let projects_dir =
        std::path::PathBuf::from(home).join(".claude").join("projects");

    if !projects_dir.exists() {
        return None;
    }

    let window_end = session_start
        .checked_add(std::time::Duration::from_secs(60))
        .unwrap_or(session_start);

    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;

    let project_entries = match std::fs::read_dir(&projects_dir) {
        Ok(rd) => rd,
        Err(_) => return None,
    };

    for project_entry in project_entries.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }

        let file_entries = match std::fs::read_dir(&project_path) {
            Ok(rd) => rd,
            Err(_) => continue,
        };

        for file_entry in file_entries.flatten() {
            let file_path = file_entry.path();
            if file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }

            let modified = match file_entry.metadata().and_then(|m| m.modified()) {
                Ok(t) => t,
                Err(_) => continue,
            };

            // Filter: modified time must be within session_start..window_end
            if modified < session_start || modified > window_end {
                continue;
            }

            if best.as_ref().map_or(true, |(best_time, _)| modified > *best_time) {
                best = Some((modified, file_path));
            }
        }
    }

    best.map(|(_, path)| path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp_jsonl(lines: &[&str]) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for line in lines {
            writeln!(f, "{}", line).unwrap();
        }
        f.flush().unwrap();
        f
    }

    #[test]
    fn parse_tool_use_entry() {
        let line = r#"{"type":"tool_use","id":"tu_1","name":"Read","input":{}}"#;
        let f = write_temp_jsonl(&[line]);
        let path = f.path().to_path_buf();

        // Create watcher already initialized so it reads from start (offset=0)
        let mut watcher = TranscriptWatcher {
            path,
            file: None,
            offset: 0,
            active_tools: VecDeque::new(),
            active_agents: Vec::new(),
            pending_permissions: false,
            initialized: true, // already initialized, no seek-to-end
            pending_tool_ids: Vec::new(),
            anonymous_pending_count: 0,
        };

        let update = watcher.poll();
        assert!(update.is_some(), "expected a MetricUpdate");
        let u = update.unwrap();
        assert!(
            u.active_tools.contains(&"Read".to_string()),
            "active_tools should contain Read, got: {:?}",
            u.active_tools
        );
        assert_eq!(u.source, Some("transcript".to_string()));
    }

    #[test]
    fn parse_agent_tool_use() {
        let line = r#"{"type":"tool_use","id":"tu_2","name":"Task","input":{}}"#;
        let f = write_temp_jsonl(&[line]);
        let path = f.path().to_path_buf();

        let mut watcher = TranscriptWatcher {
            path,
            file: None,
            offset: 0,
            active_tools: VecDeque::new(),
            active_agents: Vec::new(),
            pending_permissions: false,
            initialized: true,
            pending_tool_ids: Vec::new(),
            anonymous_pending_count: 0,
        };

        let update = watcher.poll().unwrap();
        assert!(
            update.active_agents.contains(&"Task".to_string()),
            "active_agents should contain Task, got: {:?}",
            update.active_agents
        );
    }

    #[test]
    fn seek_to_end_on_first_open() {
        // Write lines before creating watcher (these should NOT be seen)
        let f = write_temp_jsonl(&[
            r#"{"type":"tool_use","id":"tu_old","name":"Bash","input":{}}"#,
        ]);
        let path = f.path().to_path_buf();

        // Normal construction: initialized=false, will seek to end
        let mut watcher = TranscriptWatcher::new(path.clone());
        // poll once to trigger the seek-to-end open
        let update = watcher.poll();
        // Should return None because there are no NEW lines after seek-to-end
        assert!(
            update.is_none(),
            "watcher should not see pre-existing lines; got: {:?}",
            update.map(|u| u.active_tools)
        );
    }

    #[test]
    fn handles_missing_file_gracefully() {
        let path = PathBuf::from("/tmp/terminai-transcript-does-not-exist-xyz.jsonl");
        let mut watcher = TranscriptWatcher::new(path);
        // Should not panic
        let update = watcher.poll();
        assert!(update.is_none());
    }

    #[test]
    fn pending_permissions_cleared_by_tool_result() {
        let lines = &[
            r#"{"type":"tool_use","id":"tu_3","name":"Edit","input":{}}"#,
            r#"{"type":"tool_result","tool_use_id":"tu_3","content":""}"#,
        ];
        let f = write_temp_jsonl(lines);
        let path = f.path().to_path_buf();

        let mut watcher = TranscriptWatcher {
            path,
            file: None,
            offset: 0,
            active_tools: VecDeque::new(),
            active_agents: Vec::new(),
            pending_permissions: false,
            initialized: true,
            pending_tool_ids: Vec::new(),
            anonymous_pending_count: 0,
        };

        let update = watcher.poll().unwrap();
        // After tool_result arrives, pending_permissions should be false
        assert_eq!(
            update.pending_permissions,
            Some(false),
            "pending_permissions should be false after tool_result"
        );
    }
}
