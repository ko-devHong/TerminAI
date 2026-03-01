mod commands;
mod provider;
mod state;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::spawn_session,
            commands::write_to_session,
            commands::resize_session,
            commands::kill_session,
            commands::detect_providers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
