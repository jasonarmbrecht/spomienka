//! Frame Viewer - Digital photo frame client for Raspberry Pi.
//!
//! Displays published media from PocketBase with transitions, caching, and realtime sync.

mod assets;
mod cache;
mod discovery;
mod realtime;
mod renderer;
mod video;

use anyhow::{Context, Result};
use assets::{AssetManager, AssetType, Media, Preloader};
use cache::Cache;
use config::{Config, Environment, File};
use realtime::{spawn_realtime, RealtimeEvent};
use renderer::{
    MediaInfoOverlay, MediaTextures, OverlayInfo, Renderer, SlideLayout, SlideLayoutKind,
    Transition, UserAction,
};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use std::collections::VecDeque;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};
use video::VideoManager;

/// Application configuration loaded from TOML file with environment variable overrides.
///
/// SECURITY: Auth credentials (auth_email, auth_password) are ONLY loaded from
/// environment variables, never from config files, to prevent credential leakage.
#[derive(Debug, Deserialize)]
struct AppConfig {
    /// PocketBase API URL (env: POCKETBASE_URL or config: pb_url)
    #[serde(default = "default_pb_url")]
    pb_url: String,

    /// Slide display interval in milliseconds
    #[serde(default = "default_interval_ms")]
    interval_ms: u64,

    /// Transition type: fade, crossfade, cut
    #[serde(default = "default_transition")]
    transition: String,

    /// Transition duration in milliseconds
    #[serde(default = "default_transition_duration_ms")]
    transition_duration_ms: u32,

    /// Local cache directory for downloaded assets
    #[serde(default = "default_cache_dir")]
    cache_dir: String,

    /// Maximum cache size in GB
    #[serde(default = "default_cache_size_limit_gb")]
    cache_size_limit_gb: u64,

    /// Optional device ID for device-specific playlisting
    #[serde(default)]
    device_id: Option<String>,

    /// Optional device API key (stored in config but auth is done via email/password)
    #[serde(default)]
    device_api_key: Option<String>,

    /// Direct auth token for PocketBase (env: AUTH_TOKEN)
    /// Loaded from environment variable only for security
    #[serde(skip)]
    auth_token: Option<String>,

    /// Auth email for PocketBase (env: AUTH_EMAIL)
    /// Loaded from environment variable only for security
    #[serde(skip)]
    auth_email: Option<String>,

    /// Auth password for PocketBase (env: AUTH_PASSWORD)
    /// Loaded from environment variable only for security
    #[serde(skip)]
    auth_password: Option<String>,

    /// Enable realtime subscription (default: true)
    #[serde(default = "default_enable_realtime")]
    enable_realtime: bool,

    /// Video loop threshold in seconds (default: 30)
    #[serde(default = "default_video_loop_threshold_sec")]
    video_loop_threshold_sec: f32,

    /// Shuffle playlist order
    #[serde(default)]
    shuffle: bool,

    /// Full sync mode - preload all media on startup
    #[serde(default)]
    full_sync: bool,

    /// Run in fullscreen mode (default: true). Set to false for windowed dev mode.
    #[serde(default = "default_fullscreen")]
    fullscreen: bool,

    /// Show blurred background behind images (default: true).
    #[serde(default = "default_blur_background")]
    pub blur_background: bool,

    /// Show a subtle clock in the bottom-right corner (default: true).
    #[serde(default = "default_show_clock")]
    pub show_clock: bool,

    /// Start with the full media info overlay visible (default: false).
    #[serde(default)]
    pub show_info: bool,

    /// Start with the location & date overlay visible (default: false).
    #[serde(default)]
    pub show_location_info: bool,

    /// Display layout mode: "single" or "dynamic" (default: "single").
    #[serde(default = "default_display_mode")]
    pub display_mode: String,
}

fn default_pb_url() -> String {
    "http://localhost:8090".to_string()
}

fn default_interval_ms() -> u64 {
    8000
}

fn default_transition() -> String {
    "fade".to_string()
}

fn default_transition_duration_ms() -> u32 {
    1000
}

fn default_cache_dir() -> String {
    "/var/cache/frame-viewer".to_string()
}

fn default_cache_size_limit_gb() -> u64 {
    10
}

fn default_enable_realtime() -> bool {
    true
}

fn default_video_loop_threshold_sec() -> f32 {
    30.0
}

fn default_fullscreen() -> bool {
    true
}

fn default_blur_background() -> bool {
    true
}

fn default_show_clock() -> bool {
    true
}

fn default_display_mode() -> String {
    "single".to_string()
}

impl AppConfig {
    /// Load configuration from file and environment variables.
    ///
    /// SECURITY: Auth credentials are loaded from environment variables only,
    /// never from config files, to prevent credential leakage through backups
    /// or version control.
    fn load() -> Result<Self> {
        let mut builder = Config::builder()
            .set_default("pb_url", default_pb_url())?
            .set_default("interval_ms", default_interval_ms() as i64)?
            .set_default("transition", default_transition())?
            .set_default(
                "transition_duration_ms",
                default_transition_duration_ms() as i64,
            )?
            .set_default("cache_dir", default_cache_dir())?
            .set_default("cache_size_limit_gb", default_cache_size_limit_gb() as i64)?
            .set_default("enable_realtime", default_enable_realtime())?
            .set_default(
                "video_loop_threshold_sec",
                default_video_loop_threshold_sec() as f64,
            )?
            .set_default("show_clock", default_show_clock())?
            .add_source(File::with_name("/etc/frame-viewer/config").required(false))
            .add_source(File::with_name("config").required(false));

        // Allow overriding pb_url with the commonly documented env var.
        if let Ok(pb_url) = env::var("POCKETBASE_URL") {
            builder = builder.set_override("pb_url", pb_url)?;
        }

        let config = builder
            .add_source(
                Environment::default()
                    .prefix("POCKETBASE")
                    .prefix_separator("_")
                    .try_parsing(true)
                    .separator("_"),
            )
            .add_source(Environment::default().try_parsing(true))
            .build()?;

        let mut app_config: AppConfig = config.try_deserialize()?;

        // Load auth credentials from environment variables ONLY (security)
        app_config.auth_token = env::var("AUTH_TOKEN").ok().filter(|s| !s.is_empty());
        app_config.auth_email = env::var("AUTH_EMAIL").ok().filter(|s| !s.is_empty());
        app_config.auth_password = env::var("AUTH_PASSWORD").ok().filter(|s| !s.is_empty());

        Ok(app_config)
    }

    fn to_auth_creds(&self) -> AuthCreds {
        AuthCreds {
            token: self.auth_token.clone().filter(|s| !s.is_empty()),
            email: self.auth_email.clone().filter(|s| !s.is_empty()),
            password: self.auth_password.clone().filter(|s| !s.is_empty()),
        }
    }
}

#[derive(Debug, Clone)]
struct AuthCreds {
    email: Option<String>,
    password: Option<String>,
    token: Option<String>,
}

impl AuthCreds {
    fn can_login(&self) -> bool {
        self.email.is_some() && self.password.is_some()
    }
}

#[derive(Debug, Deserialize)]
struct ListResponse<T> {
    items: Vec<T>,
}

/// Application state shared across tasks.
struct AppState {
    config: AppConfig,
    client: Client,
    auth_token: RwLock<Option<String>>,
    playlist: RwLock<Vec<Media>>,
    current_index: RwLock<usize>,
    cache: Arc<RwLock<Cache>>,
    asset_manager: Arc<AssetManager>,
    is_offline: RwLock<bool>,
    /// Active tag filter: (tags, mode) where mode is "whitelist" or "blacklist".
    tag_filter: RwLock<Option<(Vec<String>, String)>>,
}

impl AppState {
    async fn new(config: AppConfig) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .context("Failed to create HTTP client")?;

        let cache = Cache::new(config.cache_dir.clone().into(), config.cache_size_limit_gb)?;
        let cache = Arc::new(RwLock::new(cache));

        let asset_manager = Arc::new(AssetManager::new(cache.clone(), config.pb_url.clone()));

        Ok(Self {
            config,
            client,
            auth_token: RwLock::new(None),
            playlist: RwLock::new(Vec::new()),
            current_index: RwLock::new(0),
            cache,
            asset_manager,
            is_offline: RwLock::new(false),
            tag_filter: RwLock::new(None),
        })
    }

    /// Get the current auth token.
    async fn token(&self) -> Option<String> {
        self.auth_token.read().await.clone()
    }

    async fn preload_media_safe(&self, media: &Media) -> Result<()> {
        let token = self.token().await;
        self.asset_manager
            .preload_media(media, &self.client, token.as_deref())
            .await
    }

    /// Fetch playlist from PocketBase.
    async fn fetch_playlist(&self) -> Result<Vec<Media>> {
        let creds = self.config.to_auth_creds();
        let mut token = self.auth_token.write().await;

        // Build filter with device scope and optional tag filter
        let filter = self.build_filter().await;
        let url = format!(
            "{}/api/collections/media/records?filter={}&perPage=500&sort=-created",
            self.config.pb_url,
            urlencoding::encode(&filter)
        );

        let result = self.fetch_with_retry(&url, &mut token, &creds).await;

        match result {
            Ok(media) => {
                *self.is_offline.write().await = false;
                Ok(media)
            }
            Err(e) => {
                tracing::warn!("Failed to fetch playlist: {}", e);
                *self.is_offline.write().await = true;

                // Try to load from cache
                let cache = self.cache.read().await;
                let cached = cache.load_playlist()?;
                if !cached.is_empty() {
                    tracing::info!("Using cached playlist with {} items", cached.len());
                    return Ok(cached);
                }

                Err(e)
            }
        }
    }

    /// Build the filter string for media queries.
    async fn build_filter(&self) -> String {
        let mut filter = "status='published'".to_string();

        if let Some(ref device_id) = self.config.device_id {
            // Allow media when deviceScopes contains this device, is null, or is an empty array.
            // deviceScopes is a JSON field — `:len=0` is not valid; compare against null/'[]'/''.
            let device_filter = format!(
                "(deviceScopes~'\"{}\"' || deviceScopes = null || deviceScopes = '[]' || deviceScopes = '')",
                device_id
            );
            filter = format!("({}) && {}", filter, device_filter);
        }

        if let Some((tags, mode)) = &*self.tag_filter.read().await {
            if !tags.is_empty() {
                let tag_conditions: Vec<String> = tags
                    .iter()
                    .map(|t| format!("tags~'\"{}\"'", t.replace('\'', "\\'")))
                    .collect();
                let tag_filter = if mode == "whitelist" {
                    format!("({})", tag_conditions.join(" || "))
                } else {
                    format!("!({})", tag_conditions.join(" || "))
                };
                filter = format!("({}) && {}", filter, tag_filter);
            }
        }

        filter
    }

    /// Fetch with automatic token refresh on 401.
    async fn fetch_with_retry(
        &self,
        url: &str,
        token: &mut Option<String>,
        creds: &AuthCreds,
    ) -> Result<Vec<Media>> {
        let (status, res) = self.send_request(url, token.as_deref()).await?;

        if status != StatusCode::UNAUTHORIZED {
            return self.parse_list(res).await;
        }

        // Try to refresh token
        if let Some(new_token) = self.refresh_token(creds).await? {
            *token = Some(new_token.clone());
            let (_, res) = self.send_request(url, Some(&new_token)).await?;
            return self.parse_list(res).await;
        }

        Err(anyhow::anyhow!(
            "Unauthorized and no credentials to refresh"
        ))
    }

    async fn send_request(
        &self,
        url: &str,
        token: Option<&str>,
    ) -> Result<(StatusCode, reqwest::Response)> {
        let mut req = self.client.get(url);
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let res = req.send().await?;
        let status = res.status();
        if status == StatusCode::UNAUTHORIZED {
            return Ok((status, res));
        }
        let res = res.error_for_status()?;
        Ok((status, res))
    }

    async fn parse_list(&self, res: reqwest::Response) -> Result<Vec<Media>> {
        let parsed: ListResponse<Media> = res.json().await?;
        Ok(parsed.items)
    }

    async fn refresh_token(&self, creds: &AuthCreds) -> Result<Option<String>> {
        // Priority 1: Direct auth token
        if let Some(ref token) = creds.token {
            return Ok(Some(token.clone()));
        }

        // Priority 2: User email/password login (preferred — device_api_key is not a PB JWT)
        if !creds.can_login() {
            return Ok(None);
        }

        let url = format!(
            "{}/api/collections/users/auth-with-password",
            self.config.pb_url
        );

        #[derive(Deserialize)]
        struct AuthResponse {
            token: String,
        }

        let res = self
            .client
            .post(&url)
            .json(&serde_json::json!({
                "identity": creds.email.as_ref().unwrap(),
                "password": creds.password.as_ref().unwrap(),
            }))
            .send()
            .await?
            .error_for_status()?;

        let parsed: AuthResponse = res.json().await?;
        Ok(Some(parsed.token))
    }

    /// Fetch playlist with exponential backoff retry.
    async fn fetch_playlist_with_retry(&self, max_retries: u32) -> Result<Vec<Media>> {
        let mut last_error = None;
        let mut delay = Duration::from_secs(1);

        for attempt in 0..=max_retries {
            if attempt > 0 {
                tracing::info!(
                    "Retrying playlist fetch (attempt {}/{}) after {:?}...",
                    attempt + 1,
                    max_retries + 1,
                    delay
                );
                tokio::time::sleep(delay).await;
                delay = std::cmp::min(delay * 2, Duration::from_secs(60)); // Cap at 60s
            }

            match self.fetch_playlist().await {
                Ok(playlist) => return Ok(playlist),
                Err(e) => {
                    tracing::warn!("Playlist fetch attempt {} failed: {}", attempt + 1, e);
                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            anyhow::anyhow!("Failed to fetch playlist after {} retries", max_retries)
        }))
    }
}

/// Response from POST /api/spomienka/device-auth.
#[derive(Deserialize)]
struct DeviceAuthResponse {
    token: String,
    config: serde_json::Value,
}

/// Authenticate as a device using device_id + device_api_key.
/// Updates lastSeen on the backend and returns device config.
async fn device_auth(
    client: &reqwest::Client,
    pb_url: &str,
    device_id: &str,
    api_key: &str,
) -> Result<DeviceAuthResponse> {
    let res = client
        .post(format!("{}/api/spomienka/device-auth", pb_url))
        .json(&serde_json::json!({ "device_id": device_id, "api_key": api_key }))
        .send()
        .await?
        .error_for_status()?;
    Ok(res.json::<DeviceAuthResponse>().await?)
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env().add_directive("frame_viewer=info".parse()?))
        .init();

    // Load configuration
    let mut config = AppConfig::load()?;

    // Discovery mode: when no device_id is configured, show a PIN screen and wait
    // for an admin to register this viewer via the Settings page.
    if config.device_id.is_none() {
        return run_discovery_mode(&config).await;
    }

    tracing::info!("Starting frame-viewer");
    tracing::info!("  PocketBase URL: {}", config.pb_url);
    tracing::info!("  Interval: {}ms", config.interval_ms);
    tracing::info!(
        "  Transition: {} ({}ms)",
        config.transition,
        config.transition_duration_ms
    );
    tracing::info!("  Blur background: {}", config.blur_background);
    tracing::info!("  Clock: {}", config.show_clock);
    tracing::info!(
        "  Cache: {} ({} GB limit)",
        config.cache_dir,
        config.cache_size_limit_gb
    );
    if let Some(ref device_id) = config.device_id {
        tracing::info!("  Device ID: {}", device_id);
    }

    // Authenticate with the backend using device credentials.
    // This validates the device is still registered, updates lastSeen, and returns
    // admin-controlled display config (interval, transition, etc.).
    let pre_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let _device_token: Option<String> = if let (Some(ref id), Some(ref key)) =
        (config.device_id.clone(), config.device_api_key.clone())
    {
        match device_auth(&pre_client, &config.pb_url, id, key).await {
            Ok(resp) => {
                let cfg = &resp.config;
                if let Some(v) = cfg.get("interval").and_then(|v| v.as_u64()) {
                    config.interval_ms = v;
                }
                if let Some(v) = cfg.get("transition").and_then(|v| v.as_str()) {
                    config.transition = v.to_string();
                }
                if let Some(v) = cfg.get("transitionDuration").and_then(|v| v.as_u64()) {
                    config.transition_duration_ms = v as u32;
                }
                if let Some(v) = cfg.get("shuffle").and_then(|v| v.as_bool()) {
                    config.shuffle = v;
                }
                if let Some(v) = cfg.get("blur").and_then(|v| v.as_bool()) {
                    config.blur_background = v;
                }
                if let Some(v) = cfg.get("showClock").and_then(|v| v.as_bool()) {
                    config.show_clock = v;
                }
                if let Some(v) = cfg.get("showInfo").and_then(|v| v.as_bool()) {
                    config.show_info = v;
                }
                if let Some(v) = cfg.get("showLocationInfo").and_then(|v| v.as_bool()) {
                    config.show_location_info = v;
                }
                if let Some(v) = cfg.get("displayMode").and_then(|v| v.as_str()) {
                    config.display_mode = v.to_string();
                }
                tracing::info!("Device authenticated — applied config from PocketBase");
                Some(resp.token)
            }
            Err(e) => {
                tracing::error!(
                    "Device auth failed: {} — is this device still registered?",
                    e
                );
                None
            }
        }
    } else {
        None
    };

    // Initialize GStreamer for video
    video::VideoPlayer::init()?;

    // Create application state (media collection is public — no user auth needed)
    let state = Arc::new(AppState::new(config).await?);

    // Fetch initial playlist with retry logic
    let playlist = match state.fetch_playlist_with_retry(5).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("Failed to fetch initial playlist after retries: {}", e);
            Vec::new()
        }
    };

    if playlist.is_empty() {
        tracing::warn!("No media items in playlist");
    } else {
        tracing::info!("Loaded {} media items", playlist.len());

        // Save playlist to cache
        let cache = state.cache.read().await;
        if let Err(e) = cache.save_playlist(&playlist) {
            tracing::warn!("Failed to save playlist to cache: {}", e);
        }
    }

    *state.playlist.write().await = playlist.clone();

    // Shuffle / reorder the playlist
    {
        let mut playlist = state.playlist.write().await;
        if state.config.display_mode == "dynamic" {
            // In dynamic mode always reorder into layout-compatible groups so that
            // multi-image layouts (quad-landscape, portrait+2-landscape, etc.) fire reliably.
            reorder_for_dynamic_layouts(&mut playlist);
        } else if state.config.shuffle {
            use rand::seq::SliceRandom;
            playlist.shuffle(&mut rand::thread_rng());
        }
    }

    // Start preloader for initial assets
    let preloader = Preloader::new(state.asset_manager.clone(), state.client.clone());
    let token = state.token().await;
    let playlist_clone = playlist.clone();

    // Full sync mode: preload all media on startup
    if state.config.full_sync && !playlist.is_empty() {
        tracing::info!(
            "Full sync mode enabled - preloading all {} media items...",
            playlist.len()
        );
        let sync_preloader = Preloader::new(state.asset_manager.clone(), state.client.clone());
        let sync_token = state.token().await;
        let sync_playlist = playlist.clone();

        // Run full sync in foreground so user knows when it's done
        sync_preloader
            .preload_all(&sync_playlist, sync_token.as_deref())
            .await;
        tracing::info!("Full sync complete");
    } else {
        // Preload first few items in background
        tokio::spawn(async move {
            preloader
                .preload_next(&playlist_clone, 0, 3, token.as_deref())
                .await;
        });
    }

    // Periodic heartbeat — keeps lastSeen fresh so the admin UI can show live status.
    // Runs every 90 seconds; errors are silently dropped so a network blip never crashes the viewer.
    if let (Some(device_id), Some(api_key)) = (
        state.config.device_id.clone(),
        state.config.device_api_key.clone(),
    ) {
        let hb_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let pb_url = state.config.pb_url.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(90)).await;
                let _ = hb_client
                    .post(format!("{}/api/spomienka/device-heartbeat", pb_url))
                    .json(&serde_json::json!({ "device_id": device_id, "api_key": api_key }))
                    .send()
                    .await;
            }
        });
    }

    // Start realtime subscription if enabled
    let mut realtime_rx = if state.config.enable_realtime {
        let token = state.token().await;
        Some(spawn_realtime(
            state.config.pb_url.clone(),
            state.config.device_id.clone(),
            token,
        ))
    } else {
        None
    };

    // Run the main render loop
    run_render_loop(state.clone(), &mut realtime_rx).await?;

    Ok(())
}

/// Discovery mode render loop — shown when no device_id is configured.
///
/// Displays a PIN on screen, announces to the backend, and polls for a registration
/// claim. On success, writes credentials to config.toml and exits (systemd restarts).
async fn run_discovery_mode(config: &AppConfig) -> Result<()> {
    let state = discovery::DiscoveryState::new()?;
    tracing::info!(
        "Discovery mode — PIN: {}  Session: {}",
        state.pin,
        state.session_id
    );
    tracing::info!("Local IP: {}  Hostname: {}", state.local_ip, state.hostname);
    tracing::info!("Announcing to {}", config.pb_url);

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .context("Failed to create HTTP client")?;

    let (claim_tx, mut claim_rx) = tokio::sync::mpsc::channel::<discovery::ClaimResult>(1);

    // Background task: announce every 15 seconds
    {
        let client = client.clone();
        let pb_url = config.pb_url.clone();
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                match discovery::announce(&client, &pb_url, &state).await {
                    Ok(()) => tracing::debug!("Announce sent"),
                    Err(e) => tracing::warn!("Announce failed: {}", e),
                }
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        });
    }

    // Background task: poll for claim every 5 seconds
    {
        let client = client.clone();
        let pb_url = config.pb_url.clone();
        let session_id = state.session_id.clone();
        let tx = claim_tx;
        tokio::spawn(async move {
            // Wait briefly so the announce fires first
            tokio::time::sleep(Duration::from_secs(3)).await;
            loop {
                match discovery::poll_claim(&client, &pb_url, &session_id).await {
                    Ok(Some(result)) => {
                        tracing::info!("Claim received — device registered!");
                        tx.send(result).await.ok();
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => tracing::debug!("Claim poll: {}", e),
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
    }

    // Initialize TTF
    let ttf_context =
        sdl2::ttf::init().map_err(|e| anyhow::anyhow!("SDL TTF init failed: {}", e))?;

    // Show the PIN screen via SDL2
    let mut renderer = renderer::Renderer::new(
        &ttf_context,
        renderer::Transition::Cut,
        0,
        config.fullscreen,
        false,
        false,
        SlideLayout::Single,
    )?;

    loop {
        // Check for successful registration
        if let Ok(result) = claim_rx.try_recv() {
            match discovery::write_device_credentials(&result.device_id, &result.api_key) {
                Ok(()) => tracing::info!("Credentials written — restarting"),
                Err(e) => tracing::error!("Failed to write credentials: {}", e),
            }
            std::thread::sleep(Duration::from_secs(1));
            // Re-exec this binary in-place so env vars (AUTH_EMAIL etc.) are inherited.
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                let exe = std::env::current_exe()
                    .unwrap_or_else(|_| std::path::PathBuf::from("frame-viewer"));
                let err = std::process::Command::new(&exe)
                    .args(std::env::args_os().skip(1))
                    .exec();
                tracing::error!("Re-exec failed: {} — falling back to exit", err);
            }
            std::process::exit(0);
        }

        // Handle quit key
        if renderer.process_events_extended() == renderer::UserAction::Quit {
            break;
        }

        renderer.render_discovery_screen(&state.pin, &state.local_ip)?;
        renderer.frame_delay();
    }

    Ok(())
}

/// Main render loop.
async fn run_render_loop(
    state: Arc<AppState>,
    realtime_rx: &mut Option<tokio::sync::mpsc::Receiver<RealtimeEvent>>,
) -> Result<()> {
    // Initialize renderer
    let ttf_context =
        sdl2::ttf::init().map_err(|e| anyhow::anyhow!("SDL TTF init failed: {}", e))?;
    let transition = Transition::from_str(&state.config.transition);
    let mut renderer = Renderer::new(
        &ttf_context,
        transition,
        state.config.transition_duration_ms,
        state.config.fullscreen,
        state.config.blur_background,
        state.config.show_clock,
        SlideLayout::Single, // initial layout; dynamic mode picks per-slide
    )?;

    // Initialize video manager
    let mut video_manager = VideoManager::new(state.config.video_loop_threshold_sec);

    // Create texture creator
    let texture_creator = renderer.texture_creator();

    // Panel textures (up to 4 for dynamic layouts)
    let mut current_textures = MediaTextures::new();
    let mut next_textures: Option<MediaTextures> = None;
    let mut right_textures = MediaTextures::new();
    let mut next_right_textures: Option<MediaTextures> = None;
    let mut panel2_textures = MediaTextures::new();
    let mut next_panel2_textures: Option<MediaTextures> = None;
    let mut panel3_textures = MediaTextures::new();
    let mut next_panel3_textures: Option<MediaTextures> = None;

    // Dynamic layout state
    let session_start = Instant::now();
    let mut layout_history: VecDeque<SlideLayoutKind> = VecDeque::new();
    let is_dynamic = state.config.display_mode == "dynamic";

    // Timing
    let mut last_advance = Instant::now();
    let slide_duration = Duration::from_millis(state.config.interval_ms);

    // Track if we're showing video
    let mut is_video_playing = false;

    // Overlay state
    let mut overlay_visible = false;
    let mut info_overlay_visible = state.config.show_info;
    let mut location_overlay_visible = state.config.show_location_info;
    let mut is_paused = false;
    let mut pause_until: Option<Instant> = None;
    let mut is_realtime_connected = false;

    // Load first item
    load_current_item(
        &state,
        &mut renderer,
        &texture_creator,
        &mut current_textures,
        &mut video_manager,
        &mut is_video_playing,
    )
    .await?;

    if is_dynamic {
        let peek_start = *state.current_index.read().await;
        let (layout, actual_start) = pick_dynamic_layout(
            &state,
            &layout_history,
            session_start.elapsed().as_secs() < 120,
            peek_start,
        )
        .await;
        renderer.current_layout = layout;
        *state.current_index.write().await = actual_start;
        layout_history.push_back(layout.kind());
        if layout_history.len() > 20 {
            layout_history.pop_front();
        }
        let n = layout.image_count();
        if n >= 2 {
            load_panel_item(
                &state,
                &mut renderer,
                &texture_creator,
                &mut right_textures,
                1,
            )
            .await?;
        }
        if n >= 3 {
            load_panel_item(
                &state,
                &mut renderer,
                &texture_creator,
                &mut panel2_textures,
                2,
            )
            .await?;
        }
        if n >= 4 {
            load_panel_item(
                &state,
                &mut renderer,
                &texture_creator,
                &mut panel3_textures,
                3,
            )
            .await?;
        }
    }

    loop {
        // Process SDL events with extended actions
        match renderer.process_events_extended() {
            UserAction::Quit => {
                tracing::info!("Quit requested");
                break;
            }
            UserAction::ToggleOverlay => {
                overlay_visible = !overlay_visible;
                tracing::debug!("Overlay visibility: {}", overlay_visible);
            }
            UserAction::TogglePause => {
                if is_video_playing {
                    is_paused = !is_paused;
                    if is_paused {
                        video_manager.pause();
                        tracing::debug!("Video paused");
                    } else {
                        video_manager.resume();
                        tracing::debug!("Video resumed");
                    }
                }
            }
            UserAction::Next => {
                tracing::debug!("Skip to next requested");
                advance_to_next(
                    &state,
                    &mut renderer,
                    &texture_creator,
                    &mut current_textures,
                    &mut next_textures,
                    &mut right_textures,
                    &mut next_right_textures,
                    &mut panel2_textures,
                    &mut next_panel2_textures,
                    &mut panel3_textures,
                    &mut next_panel3_textures,
                    &mut video_manager,
                    &mut is_video_playing,
                    &mut layout_history,
                    session_start,
                )
                .await?;
                last_advance = Instant::now();
                is_paused = false;
            }
            UserAction::Previous => {
                tracing::debug!("Go to previous requested");
                go_to_previous(
                    &state,
                    &mut renderer,
                    &texture_creator,
                    &mut current_textures,
                    &mut next_textures,
                    &mut right_textures,
                    &mut panel2_textures,
                    &mut panel3_textures,
                    &mut video_manager,
                    &mut is_video_playing,
                )
                .await?;
                last_advance = Instant::now();
                is_paused = false;
            }
            UserAction::Refresh => {
                tracing::info!("Manual playlist refresh requested");
                match state.fetch_playlist().await {
                    Ok(playlist) => {
                        let cache = state.cache.read().await;
                        if let Err(e) = cache.save_playlist(&playlist) {
                            tracing::warn!("Failed to save playlist: {}", e);
                        }
                        drop(cache);
                        *state.playlist.write().await = playlist;
                        tracing::info!("Playlist refreshed");
                    }
                    Err(e) => {
                        tracing::error!("Failed to refresh playlist: {}", e);
                    }
                }
            }
            UserAction::None => {}
        }

        // Auto-resume after timed pause expires
        if let Some(until) = pause_until {
            if Instant::now() >= until {
                is_paused = false;
                pause_until = None;
                if is_video_playing {
                    video_manager.resume();
                }
                tracing::debug!("Timed pause expired, resuming");
            }
        }

        // Process realtime events
        if let Some(ref mut rx) = realtime_rx {
            while let Ok(event) = rx.try_recv() {
                match event {
                    RealtimeEvent::Connected => is_realtime_connected = true,
                    RealtimeEvent::Disconnected => is_realtime_connected = false,
                    RealtimeEvent::RemoteNext => {
                        tracing::debug!("Remote: next");
                        advance_to_next(
                            &state,
                            &mut renderer,
                            &texture_creator,
                            &mut current_textures,
                            &mut next_textures,
                            &mut right_textures,
                            &mut next_right_textures,
                            &mut panel2_textures,
                            &mut next_panel2_textures,
                            &mut panel3_textures,
                            &mut next_panel3_textures,
                            &mut video_manager,
                            &mut is_video_playing,
                            &mut layout_history,
                            session_start,
                        )
                        .await?;
                        last_advance = Instant::now();
                        is_paused = false;
                        pause_until = None;
                    }
                    RealtimeEvent::RemotePrev => {
                        tracing::debug!("Remote: prev");
                        go_to_previous(
                            &state,
                            &mut renderer,
                            &texture_creator,
                            &mut current_textures,
                            &mut next_textures,
                            &mut right_textures,
                            &mut panel2_textures,
                            &mut panel3_textures,
                            &mut video_manager,
                            &mut is_video_playing,
                        )
                        .await?;
                        last_advance = Instant::now();
                        is_paused = false;
                        pause_until = None;
                    }
                    RealtimeEvent::RemoteRandom => {
                        tracing::debug!("Remote: random");
                        {
                            use rand::Rng;
                            let playlist = state.playlist.read().await;
                            if !playlist.is_empty() {
                                let idx = rand::thread_rng().gen_range(0..playlist.len());
                                *state.current_index.write().await = idx;
                            }
                        }
                        load_current_item(
                            &state,
                            &mut renderer,
                            &texture_creator,
                            &mut current_textures,
                            &mut video_manager,
                            &mut is_video_playing,
                        )
                        .await?;
                        if is_dynamic {
                            let n = renderer.current_layout.image_count();
                            if n >= 2 {
                                load_panel_item(
                                    &state,
                                    &mut renderer,
                                    &texture_creator,
                                    &mut right_textures,
                                    1,
                                )
                                .await?;
                            }
                            if n >= 3 {
                                load_panel_item(
                                    &state,
                                    &mut renderer,
                                    &texture_creator,
                                    &mut panel2_textures,
                                    2,
                                )
                                .await?;
                            }
                            if n >= 4 {
                                load_panel_item(
                                    &state,
                                    &mut renderer,
                                    &texture_creator,
                                    &mut panel3_textures,
                                    3,
                                )
                                .await?;
                            }
                        }
                        last_advance = Instant::now();
                        is_paused = false;
                        pause_until = None;
                    }
                    RealtimeEvent::RemotePause { secs } => {
                        tracing::debug!("Remote: pause {}s", secs);
                        is_paused = true;
                        pause_until = Some(Instant::now() + Duration::from_secs(secs));
                        if is_video_playing {
                            video_manager.pause();
                        }
                    }
                    RealtimeEvent::RemoteResume => {
                        tracing::debug!("Remote: resume");
                        is_paused = false;
                        pause_until = None;
                        if is_video_playing {
                            video_manager.resume();
                        }
                    }
                    RealtimeEvent::RemoteToggleInfo => {
                        info_overlay_visible = !info_overlay_visible;
                        if info_overlay_visible {
                            location_overlay_visible = false;
                        }
                        tracing::debug!("Remote: info overlay {}", info_overlay_visible);
                    }
                    RealtimeEvent::RemoteToggleLocationInfo => {
                        location_overlay_visible = !location_overlay_visible;
                        if location_overlay_visible {
                            info_overlay_visible = false;
                        }
                        tracing::debug!("Remote: location overlay {}", location_overlay_visible);
                    }
                    RealtimeEvent::RemoteTagFilter { tags, mode } => {
                        tracing::info!("Remote: tag filter {:?} ({})", tags, mode);
                        *state.tag_filter.write().await = Some((tags, mode));
                        match state.fetch_playlist().await {
                            Ok(playlist) => {
                                let cache = state.cache.read().await;
                                let _ = cache.save_playlist(&playlist);
                                drop(cache);
                                *state.playlist.write().await = playlist;
                                tracing::info!("Playlist refreshed with tag filter");
                            }
                            Err(e) => tracing::error!("Failed to refresh playlist: {}", e),
                        }
                    }
                    RealtimeEvent::RemoteTagFilterClear => {
                        tracing::info!("Remote: tag filter cleared");
                        *state.tag_filter.write().await = None;
                        match state.fetch_playlist().await {
                            Ok(playlist) => {
                                let cache = state.cache.read().await;
                                let _ = cache.save_playlist(&playlist);
                                drop(cache);
                                *state.playlist.write().await = playlist;
                                tracing::info!("Playlist refreshed, tag filter removed");
                            }
                            Err(e) => tracing::error!("Failed to refresh playlist: {}", e),
                        }
                    }
                    other => {
                        handle_realtime_event(&state, other).await;
                    }
                }
            }
        }

        // Update video frame if playing and not paused
        if is_video_playing && !is_paused {
            if let Some(frame) = video_manager.current_frame() {
                // Update display texture with video frame
                if let Ok(tex) = renderer.create_texture_from_pixels(
                    &texture_creator,
                    &frame.pixels,
                    frame.width,
                    frame.height,
                ) {
                    current_textures.display = Some(tex);
                    current_textures.display_size = Some((frame.width, frame.height));
                }
            }

            // Check if non-looping video ended
            if video_manager.is_ended() && !video_manager.is_looping() {
                tracing::debug!("Video ended, advancing to next");
                is_video_playing = false;
                advance_to_next(
                    &state,
                    &mut renderer,
                    &texture_creator,
                    &mut current_textures,
                    &mut next_textures,
                    &mut right_textures,
                    &mut next_right_textures,
                    &mut panel2_textures,
                    &mut next_panel2_textures,
                    &mut panel3_textures,
                    &mut next_panel3_textures,
                    &mut video_manager,
                    &mut is_video_playing,
                    &mut layout_history,
                    session_start,
                )
                .await?;
                last_advance = Instant::now();
            }
        }

        // Update transition
        let should_swap = renderer.update_transition();
        if should_swap {
            if let Some(next) = next_textures.take() {
                current_textures = next;
            }
            if let Some(next) = next_right_textures.take() {
                right_textures = next;
            }
            if let Some(next) = next_panel2_textures.take() {
                panel2_textures = next;
            }
            if let Some(next) = next_panel3_textures.take() {
                panel3_textures = next;
            }
        }

        // Check if it's time to advance (for images or looping videos)
        // Don't auto-advance if paused
        let should_advance = !is_paused
            && !renderer.is_transitioning()
            && last_advance.elapsed() >= slide_duration
            && (!is_video_playing || video_manager.is_looping());

        if should_advance {
            advance_to_next(
                &state,
                &mut renderer,
                &texture_creator,
                &mut current_textures,
                &mut next_textures,
                &mut right_textures,
                &mut next_right_textures,
                &mut panel2_textures,
                &mut next_panel2_textures,
                &mut panel3_textures,
                &mut next_panel3_textures,
                &mut video_manager,
                &mut is_video_playing,
                &mut layout_history,
                session_start,
            )
            .await?;
            last_advance = Instant::now();
        }

        // Render image + clock (no present yet)
        if renderer.current_layout.is_multi() {
            let n = renderer.current_layout.image_count();
            let mut p: Vec<&mut MediaTextures> = vec![&mut current_textures];
            if n >= 2 {
                p.push(&mut right_textures);
            }
            if n >= 3 {
                p.push(&mut panel2_textures);
            }
            if n >= 4 {
                p.push(&mut panel3_textures);
            }
            let mut np: Vec<&mut MediaTextures> = Vec::new();
            if let Some(ref mut t) = next_textures {
                np.push(t);
            }
            if n >= 2 {
                if let Some(ref mut t) = next_right_textures {
                    np.push(t);
                }
            }
            if n >= 3 {
                if let Some(ref mut t) = next_panel2_textures {
                    np.push(t);
                }
            }
            if n >= 4 {
                if let Some(ref mut t) = next_panel3_textures {
                    np.push(t);
                }
            }
            let has_next = !np.is_empty();
            if has_next {
                renderer.render_layout(&texture_creator, &mut p, Some(&mut np))?;
            } else {
                renderer.render_layout(&texture_creator, &mut p, None)?;
            }
        } else {
            renderer.render(
                &texture_creator,
                &mut current_textures,
                next_textures.as_mut(),
            )?;
        }

        // Render debug overlay on top
        if overlay_visible {
            let overlay_info = build_overlay_info(
                &state,
                &video_manager,
                is_video_playing,
                is_paused,
                pause_until,
                is_realtime_connected,
            )
            .await;
            if let Err(e) = renderer.render_overlay(&overlay_info) {
                tracing::warn!("Failed to render overlay: {}", e);
            }
        }

        // Render media info overlay on top
        if info_overlay_visible {
            let n = renderer.current_layout.image_count();
            if n > 1 {
                let mut infos = Vec::new();
                for i in 0..n {
                    infos.push(build_media_info_overlay(&state, i).await);
                }
                if let Err(e) = renderer.render_info_overlay_multi(&infos) {
                    tracing::warn!("Failed to render multi info overlay: {}", e);
                }
            } else {
                let media_info = build_media_info_overlay(&state, 0).await;
                if let Err(e) = renderer.render_info_overlay(&media_info) {
                    tracing::warn!("Failed to render info overlay: {}", e);
                }
            }
        } else if location_overlay_visible {
            let n = renderer.current_layout.image_count();
            if n > 1 {
                let mut infos = Vec::new();
                for i in 0..n {
                    infos.push(build_location_info_overlay(&state, i).await);
                }
                if let Err(e) = renderer.render_info_overlay_multi(&infos) {
                    tracing::warn!("Failed to render multi location overlay: {}", e);
                }
            } else {
                let loc_info = build_location_info_overlay(&state, 0).await;
                if let Err(e) = renderer.render_info_overlay(&loc_info) {
                    tracing::warn!("Failed to render location overlay: {}", e);
                }
            }
        }

        // Present everything (image + clock + any overlays) in one call
        renderer.present();

        // Frame delay
        renderer.frame_delay();
    }

    // Cleanup
    video_manager.stop();

    Ok(())
}

/// Build overlay info from current state.
async fn build_overlay_info(
    state: &AppState,
    video_manager: &VideoManager,
    is_video_playing: bool,
    is_paused: bool,
    pause_until: Option<Instant>,
    is_realtime_connected: bool,
) -> OverlayInfo {
    let playlist = state.playlist.read().await;
    let current_index = *state.current_index.read().await;
    let is_offline = *state.is_offline.read().await;

    let media_title = playlist
        .get(current_index)
        .map(|m| m.id.clone())
        .unwrap_or_default();

    let is_video = playlist
        .get(current_index)
        .map(|m| m.is_video())
        .unwrap_or(false);

    let cache = state.cache.read().await;
    let cache_stats = cache.stats();

    let pause_secs_remaining = pause_until.and_then(|until| {
        let now = Instant::now();
        if until > now {
            Some(until.duration_since(now).as_secs())
        } else {
            None
        }
    });

    OverlayInfo {
        is_connected: is_realtime_connected,
        is_offline,
        current_index: current_index + 1, // 1-based for display
        total_count: playlist.len(),
        media_title,
        cache_used: cache_stats.current_size,
        cache_max: cache_stats.max_size,
        cache_items: cache_stats.item_count,
        is_video,
        is_paused,
        pause_secs_remaining,
        video_duration: if is_video_playing {
            video_manager.duration()
        } else {
            None
        },
        video_position: if is_video_playing {
            video_manager.position()
        } else {
            None
        },
    }
}

/// Build media info overlay from the playlist item at `current_index + offset`.
async fn build_media_info_overlay(state: &AppState, offset: usize) -> MediaInfoOverlay {
    let playlist = state.playlist.read().await;
    let base = *state.current_index.read().await;
    let index = if playlist.is_empty() {
        0
    } else {
        (base + offset) % playlist.len()
    };
    let Some(media) = playlist.get(index) else {
        return MediaInfoOverlay::default();
    };

    let tags = media
        .tags
        .as_ref()
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    MediaInfoOverlay {
        title: media.title.clone(),
        description: media.description.clone(),
        location: media.location.clone(),
        tags,
        taken_at: media.taken_at.as_deref().map(format_taken_at),
        dimensions: media.width.zip(media.height),
        camera_make: media.camera_make.clone(),
        camera_model: media.camera_model.clone(),
        focal_length: media.focal_length.clone(),
        f_number: media.f_number.clone(),
        exposure_time: media.exposure_time.clone(),
        iso: media.iso.clone(),
    }
}

async fn build_location_info_overlay(state: &AppState, offset: usize) -> MediaInfoOverlay {
    let playlist = state.playlist.read().await;
    let base = *state.current_index.read().await;
    let index = if playlist.is_empty() {
        0
    } else {
        (base + offset) % playlist.len()
    };
    let Some(media) = playlist.get(index) else {
        return MediaInfoOverlay::default();
    };
    MediaInfoOverlay {
        location: media.location.clone(),
        taken_at: media.taken_at.as_deref().map(format_taken_at),
        ..Default::default()
    }
}

/// Load the current item into textures.
async fn load_current_item<'a>(
    state: &AppState,
    renderer: &mut Renderer<'_>,
    texture_creator: &'a sdl2::render::TextureCreator<sdl2::video::WindowContext>,
    textures: &mut MediaTextures<'a>,
    video_manager: &mut VideoManager,
    is_video_playing: &mut bool,
) -> Result<()> {
    let playlist = state.playlist.read().await;
    let index = *state.current_index.read().await;

    if playlist.is_empty() {
        return Ok(());
    }

    let media = &playlist[index];
    tracing::debug!("Loading media: {} ({})", media.id, media.media_type);

    // Ensure assets are cached
    state.preload_media_safe(media).await?;

    // Load textures
    let cache = state.cache.read().await;
    *textures = state
        .asset_manager
        .load_textures(renderer, texture_creator, media, &cache)?;

    // Touch cache entries for LRU
    drop(cache);
    let mut cache = state.cache.write().await;
    cache.touch(&media.id, AssetType::Display);

    // Start video if applicable
    start_video_if_applicable(media, &cache, video_manager, is_video_playing);

    Ok(())
}

/// Load a panel item at `current_index + offset` (wrapping) into textures.
/// Used to load the right panel in dual-portrait mode.
async fn load_panel_item<'a>(
    state: &AppState,
    renderer: &mut Renderer<'_>,
    texture_creator: &'a sdl2::render::TextureCreator<sdl2::video::WindowContext>,
    textures: &mut MediaTextures<'a>,
    offset: usize,
) -> Result<()> {
    let playlist = state.playlist.read().await;
    if playlist.is_empty() {
        return Ok(());
    }
    let current_index = *state.current_index.read().await;
    let panel_index = (current_index + offset) % playlist.len();
    let media = &playlist[panel_index];

    state.preload_media_safe(media).await?;

    let cache = state.cache.read().await;
    *textures = state
        .asset_manager
        .load_textures(renderer, texture_creator, media, &cache)?;
    drop(cache);

    let mut cache = state.cache.write().await;
    cache.touch(&media.id, AssetType::Display);

    Ok(())
}

/// Image orientation bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImageOrientation {
    Portrait,
    Landscape,
    Square,
}

fn classify_orientation(w: u32, h: u32) -> ImageOrientation {
    if w == 0 || h == 0 {
        return ImageOrientation::Square;
    }
    let ratio = w as f32 / h as f32;
    if ratio > 1.2 {
        ImageOrientation::Landscape
    } else if ratio < 0.83 {
        ImageOrientation::Portrait
    } else {
        ImageOrientation::Square
    }
}

/// Return the visual (post-EXIF-rotation) orientation of a media item.
fn media_visual_orientation(m: &assets::Media) -> ImageOrientation {
    match (m.width, m.height) {
        (Some(w), Some(h)) => {
            let needs_swap = m
                .orientation
                .as_ref()
                .map(|v| {
                    if let Some(n) = v.as_u64() {
                        matches!(n, 5..=8)
                    } else if let Some(f) = v.as_f64() {
                        matches!(f as u64, 5..=8)
                    } else if let Some(s) = v.as_str() {
                        if let Ok(n) = s.trim().parse::<u64>() {
                            matches!(n, 5..=8)
                        } else {
                            s.contains("90") || s.contains("270")
                        }
                    } else {
                        false
                    }
                })
                .unwrap_or(false);
            let (vw, vh) = if needs_swap { (h, w) } else { (w, h) };
            classify_orientation(vw, vh)
        }
        _ => ImageOrientation::Landscape,
    }
}

/// Reorder a playlist into layout-compatible groups so that the sequential layout picker
/// reliably finds valid multi-image combinations (quad-landscape, portrait+2-landscape, etc.).
///
/// Images are separated by orientation, each bucket is independently shuffled, then groups
/// are drawn greedily in random weighted order until all images are placed. This guarantees
/// that consecutive runs of the same orientation always exist, enabling every layout type.
fn reorder_for_dynamic_layouts(images: &mut Vec<assets::Media>) {
    use rand::seq::SliceRandom;
    use rand::Rng;
    let mut rng = rand::thread_rng();

    // Drain into orientation buckets
    let mut landscapes: std::collections::VecDeque<assets::Media> = Default::default();
    let mut portraits: std::collections::VecDeque<assets::Media> = Default::default();
    let mut squares: std::collections::VecDeque<assets::Media> = Default::default();
    for img in images.drain(..) {
        match media_visual_orientation(&img) {
            ImageOrientation::Landscape => landscapes.push_back(img),
            ImageOrientation::Portrait => portraits.push_back(img),
            ImageOrientation::Square => squares.push_back(img),
        }
    }
    // Shuffle each bucket so order is random within orientation groups
    let (mut lv, mut pv, mut sv): (Vec<_>, Vec<_>, Vec<_>) = (
        landscapes.into_iter().collect(),
        portraits.into_iter().collect(),
        squares.into_iter().collect(),
    );
    lv.shuffle(&mut rng);
    pv.shuffle(&mut rng);
    sv.shuffle(&mut rng);
    let mut l = std::collections::VecDeque::from(lv);
    let mut p = std::collections::VecDeque::from(pv);
    let mut s = std::collections::VecDeque::from(sv);

    // Greedily form layout groups until all buckets are empty
    loop {
        let (lc, pc, sc) = (l.len(), p.len(), s.len());
        if lc == 0 && pc == 0 && sc == 0 {
            break;
        }

        // Build weighted option list based on what's available
        // 0=QuadLandscape(4L), 1=PortraitDualLandscape(1P+2L), 2=DualPortrait(2P),
        // 3=SingleLandscape(1L), 4=DualSquare(2S), 5=SquarePortrait(1S+1P)
        let opts: &[(u8, f32)] = &[(0, 2.0), (1, 2.0), (2, 2.0), (3, 3.0), (4, 2.0), (5, 2.0)];
        let available: Vec<(u8, f32)> = opts
            .iter()
            .filter_map(|&(id, w)| {
                let ok = match id {
                    0 => lc >= 4,
                    1 => pc >= 1 && lc >= 2,
                    2 => pc >= 2,
                    3 => lc >= 1,
                    4 => sc >= 2,
                    5 => sc >= 1 && pc >= 1,
                    _ => false,
                };
                if ok {
                    Some((id, w))
                } else {
                    None
                }
            })
            .collect();

        if available.is_empty() {
            // Flush any leftover images that can't form a valid group
            images.extend(p.drain(..));
            images.extend(l.drain(..));
            images.extend(s.drain(..));
            break;
        }

        let total: f32 = available.iter().map(|(_, w)| *w).sum();
        let mut pick = rng.gen::<f32>() * total;
        let choice = available
            .iter()
            .find(|(_, w)| {
                pick -= *w;
                pick <= 0.0
            })
            .or_else(|| available.last())
            .map(|(id, _)| *id)
            .unwrap_or(3);

        match choice {
            0 => {
                for _ in 0..4 {
                    images.push(l.pop_front().unwrap());
                }
            }
            1 => {
                images.push(p.pop_front().unwrap());
                images.push(l.pop_front().unwrap());
                images.push(l.pop_front().unwrap());
            }
            2 => {
                images.push(p.pop_front().unwrap());
                images.push(p.pop_front().unwrap());
            }
            3 => {
                images.push(l.pop_front().unwrap());
            }
            4 => {
                images.push(s.pop_front().unwrap());
                images.push(s.pop_front().unwrap());
            }
            5 => {
                images.push(s.pop_front().unwrap());
                images.push(p.pop_front().unwrap());
            }
            _ => unreachable!(),
        }
    }
}

/// Pick a dynamic layout for the upcoming slide.
///
/// Returns `(layout, actual_start)` where `actual_start` is the playlist index the
/// caller should use for loading — normally equal to `peek_start`, but may be advanced
/// if a portrait image at `peek_start` has no valid multi-image partner and we need to
/// scan forward to avoid showing a portrait alone.
///
/// Rules:
/// - Only landscape images may be shown alone.
/// - Portrait images are NEVER shown alone; we scan forward until a valid layout exists.
/// - The 3-image layout is strictly [portrait, landscape, landscape].
/// - The 4-image layout requires 4 consecutive landscapes.
async fn pick_dynamic_layout(
    state: &AppState,
    history: &VecDeque<SlideLayoutKind>,
    warmup: bool,
    peek_start: usize,
) -> (SlideLayout, usize) {
    use rand::Rng;
    let mut rng = rand::thread_rng();

    let playlist = state.playlist.read().await;
    let n = playlist.len();
    if n == 0 {
        return (SlideLayout::Single, peek_start);
    }

    let orient_of =
        |idx: usize| -> ImageOrientation { media_visual_orientation(&playlist[idx % n]) };

    // Helper: build valid layout candidates for a given start index.
    let candidates_at =
        |start: usize, rng: &mut rand::rngs::ThreadRng| -> Vec<(SlideLayout, f32)> {
            let o0 = orient_of(start);
            let o1 = orient_of(start + 1);
            let o2 = orient_of(start + 2);
            let o3 = orient_of(start + 3);
            let mut c: Vec<(SlideLayout, f32)> = Vec::new();
            if o0 == ImageOrientation::Landscape {
                c.push((SlideLayout::Single, 3.0));
            }
            if o0 == ImageOrientation::Portrait && o1 == ImageOrientation::Portrait {
                c.push((SlideLayout::DualPortrait { flipped: rng.gen() }, 2.0));
            }
            if o0 == ImageOrientation::Portrait
                && o1 == ImageOrientation::Landscape
                && o2 == ImageOrientation::Landscape
            {
                c.push((
                    SlideLayout::PortraitDualLandscape {
                        portrait_right: rng.gen(),
                    },
                    2.0,
                ));
            }
            if o0 == ImageOrientation::Landscape
                && o1 == ImageOrientation::Landscape
                && o2 == ImageOrientation::Landscape
                && o3 == ImageOrientation::Landscape
            {
                c.push((SlideLayout::QuadLandscape { flipped: rng.gen() }, 2.0));
            }
            if o0 == ImageOrientation::Square && o1 == ImageOrientation::Square {
                c.push((SlideLayout::DualSquare { flipped: rng.gen() }, 2.0));
            }
            if o0 == ImageOrientation::Square && o1 == ImageOrientation::Portrait {
                c.push((
                    SlideLayout::SquarePortrait {
                        square_right: rng.gen(),
                    },
                    2.0,
                ));
            }
            c
        };

    // Try peek_start first; if no valid layout (portrait with no valid partner),
    // scan forward until we find a valid starting position. Cap scan at n steps.
    let (candidates, actual_start) = {
        let c = candidates_at(peek_start, &mut rng);
        if !c.is_empty() {
            (c, peek_start)
        } else {
            let mut found = (Vec::new(), peek_start);
            for offset in 1..=n {
                let try_start = (peek_start + offset) % n;
                let c = candidates_at(try_start, &mut rng);
                if !c.is_empty() {
                    tracing::debug!(
                        "pick_dynamic_layout: skipped {} images to find valid layout at {}",
                        offset,
                        try_start
                    );
                    found = (c, try_start);
                    break;
                }
            }
            found
        }
    };

    if candidates.is_empty() {
        return (SlideLayout::Single, actual_start);
    }

    let select =
        |candidates: &[(SlideLayout, f32)], rng: &mut rand::rngs::ThreadRng| -> SlideLayout {
            let idx = rng.gen_range(0..candidates.len());
            candidates[idx].0
        };

    if warmup {
        return (select(&candidates, &mut rng), actual_start);
    }

    // Bias Single to ~50% of weight; halve weight of recently shown layouts.
    let recent: Vec<SlideLayoutKind> = history.iter().rev().take(3).copied().collect();
    let single_w: f32 = candidates
        .iter()
        .find(|(l, _)| l.kind() == SlideLayoutKind::Single)
        .map(|(_, w)| *w)
        .unwrap_or(0.0);
    let other_total: f32 = candidates
        .iter()
        .filter(|(l, _)| l.kind() != SlideLayoutKind::Single)
        .map(|(_, w)| *w)
        .sum();
    let scale = if other_total > 0.0 && single_w > 0.0 {
        single_w / other_total
    } else {
        1.0
    };

    let weighted: Vec<(SlideLayout, f32)> = candidates
        .iter()
        .map(|(layout, w)| {
            let mut weight = if layout.kind() == SlideLayoutKind::Single {
                *w
            } else {
                w * scale
            };
            if recent.contains(&layout.kind()) {
                weight *= 0.5;
            }
            (*layout, weight)
        })
        .collect();

    let total: f32 = weighted.iter().map(|(_, w)| *w).sum();
    if total <= 0.0 {
        return (SlideLayout::Single, actual_start);
    }

    let mut pick = rng.gen::<f32>() * total;
    for (layout, weight) in &weighted {
        pick -= weight;
        if pick <= 0.0 {
            return (*layout, actual_start);
        }
    }
    (
        weighted
            .last()
            .map(|(l, _)| *l)
            .unwrap_or(SlideLayout::Single),
        actual_start,
    )
}

/// Advance to the next item in the playlist.
#[allow(clippy::too_many_arguments)]
async fn advance_to_next<'a>(
    state: &AppState,
    renderer: &mut Renderer<'_>,
    texture_creator: &'a sdl2::render::TextureCreator<sdl2::video::WindowContext>,
    current_textures: &mut MediaTextures<'a>,
    next_textures: &mut Option<MediaTextures<'a>>,
    right_textures: &mut MediaTextures<'a>,
    next_right_textures: &mut Option<MediaTextures<'a>>,
    panel2_textures: &mut MediaTextures<'a>,
    next_panel2_textures: &mut Option<MediaTextures<'a>>,
    panel3_textures: &mut MediaTextures<'a>,
    next_panel3_textures: &mut Option<MediaTextures<'a>>,
    video_manager: &mut VideoManager,
    is_video_playing: &mut bool,
    layout_history: &mut VecDeque<SlideLayoutKind>,
    session_start: Instant,
) -> Result<()> {
    // Stop current video
    video_manager.stop();
    *is_video_playing = false;

    {
        let playlist = state.playlist.read().await;
        if playlist.is_empty() {
            return Ok(());
        }
    }

    let is_dynamic = state.config.display_mode == "dynamic";
    let warmup = session_start.elapsed().as_secs() < 120;

    // Compute where the next slide starts (after current slide's images).
    let current_step = renderer.current_layout.image_count();
    let n = state.playlist.read().await.len();
    let current_index_val = *state.current_index.read().await;
    let next_start_raw = current_index_val + current_step;

    // In dynamic mode, regroup the playlist whenever we complete a full cycle so that
    // each new pass shows images in a freshly randomised layout-compatible order.
    if is_dynamic && next_start_raw >= n {
        let mut playlist = state.playlist.write().await;
        reorder_for_dynamic_layouts(&mut playlist);
        tracing::debug!("Dynamic mode: reordered playlist for new cycle");
    }

    let next_start = next_start_raw % n;

    // Pick layout for the next slide, peeking from next_start.
    // pick_dynamic_layout acquires the playlist lock internally — don't hold it here.
    let next_index = if is_dynamic {
        let (layout, actual_start) =
            pick_dynamic_layout(state, layout_history, warmup, next_start).await;
        renderer.current_layout = layout;
        layout_history.push_back(layout.kind());
        if layout_history.len() > 20 {
            layout_history.pop_front();
        }
        actual_start
    } else {
        next_start
    };

    let step = renderer.current_layout.image_count();
    *state.current_index.write().await = next_index;

    let playlist = state.playlist.read().await;
    if playlist.is_empty() {
        return Ok(());
    }

    let media = &playlist[next_index];
    tracing::debug!("Advancing to: {} ({})", media.id, media.media_type);

    // Preload ahead in background
    let preloader = Preloader::new(state.asset_manager.clone(), state.client.clone());
    let token = state.token().await;
    let playlist_clone = playlist.clone();
    let preload_ahead = (step * 2).max(4);

    tokio::spawn(async move {
        preloader
            .preload_next(&playlist_clone, next_index, preload_ahead, token.as_deref())
            .await;
    });

    // Ensure current item is cached and load textures
    state.preload_media_safe(media).await?;
    let cache = state.cache.read().await;
    let new_textures =
        state
            .asset_manager
            .load_textures(renderer, texture_creator, media, &cache)?;
    drop(cache);

    *next_textures = Some(new_textures);

    // Load extra panels for multi-image layouts
    if step >= 2 {
        let idx = (next_index + 1) % playlist.len();
        let m = playlist[idx].clone();
        state.preload_media_safe(&m).await?;
        let cache = state.cache.read().await;
        let t = state
            .asset_manager
            .load_textures(renderer, texture_creator, &m, &cache)?;
        drop(cache);
        *next_right_textures = Some(t);
        let mut cache = state.cache.write().await;
        cache.touch(&m.id, AssetType::Display);
    }
    if step >= 3 {
        let idx = (next_index + 2) % playlist.len();
        let m = playlist[idx].clone();
        state.preload_media_safe(&m).await?;
        let cache = state.cache.read().await;
        let t = state
            .asset_manager
            .load_textures(renderer, texture_creator, &m, &cache)?;
        drop(cache);
        *next_panel2_textures = Some(t);
        let mut cache = state.cache.write().await;
        cache.touch(&m.id, AssetType::Display);
    }
    if step >= 4 {
        let idx = (next_index + 3) % playlist.len();
        let m = playlist[idx].clone();
        drop(playlist);
        state.preload_media_safe(&m).await?;
        let cache = state.cache.read().await;
        let t = state
            .asset_manager
            .load_textures(renderer, texture_creator, &m, &cache)?;
        drop(cache);
        *next_panel3_textures = Some(t);
        let mut cache = state.cache.write().await;
        cache.touch(&m.id, AssetType::Display);
    } else {
        drop(playlist);
    }

    // Minimum-size guard: after loading actual textures, verify that every image in the
    // chosen layout renders at least 20% of the screen's width and height. If any image
    // would be too small (e.g. a landscape image incorrectly placed in a portrait slot
    // making the sibling column only a few pixels wide), fall back to Single so the first
    // image is shown full-screen and the others are deferred to subsequent slides.
    if renderer.current_layout.is_multi() {
        let (sw, sh) = renderer.screen_size();
        let min_w = sw / 5;
        let min_h = sh / 5;
        let sizes: [Option<(u32, u32)>; 4] = [
            next_textures.as_ref().and_then(|t| t.display_size),
            next_right_textures.as_ref().and_then(|t| t.display_size),
            next_panel2_textures.as_ref().and_then(|t| t.display_size),
            next_panel3_textures.as_ref().and_then(|t| t.display_size),
        ];
        let rects = Renderer::compute_panel_rects(renderer.current_layout, sw, sh, &sizes);
        let too_small = rects
            .iter()
            .any(|r| r.width() < min_w || r.height() < min_h);
        if too_small {
            tracing::warn!(
                "Layout {:?} produced image smaller than 20% of screen — falling back to Single",
                renderer.current_layout.kind()
            );
            renderer.current_layout = SlideLayout::Single;
            // Clear the extra-panel textures; they will be shown on subsequent slides.
            *next_right_textures = None;
            *next_panel2_textures = None;
            *next_panel3_textures = None;
        }
    }

    match Transition::from_str(&state.config.transition) {
        Transition::Cut => {
            if let Some(next) = next_textures.take() {
                *current_textures = next;
            }
            if let Some(next) = next_right_textures.take() {
                *right_textures = next;
            }
            if let Some(next) = next_panel2_textures.take() {
                *panel2_textures = next;
            }
            if let Some(next) = next_panel3_textures.take() {
                *panel3_textures = next;
            }
        }
        _ => {
            renderer.start_transition();
        }
    }

    // Touch cache for primary panel
    let playlist = state.playlist.read().await;
    let media = &playlist[next_index % playlist.len()];
    let mut cache = state.cache.write().await;
    cache.touch(&media.id, AssetType::Display);

    start_video_if_applicable(media, &cache, video_manager, is_video_playing);

    Ok(())
}

/// Go to the previous item in the playlist.
#[allow(clippy::too_many_arguments)]
async fn go_to_previous<'a>(
    state: &AppState,
    renderer: &mut Renderer<'_>,
    texture_creator: &'a sdl2::render::TextureCreator<sdl2::video::WindowContext>,
    current_textures: &mut MediaTextures<'a>,
    next_textures: &mut Option<MediaTextures<'a>>,
    right_textures: &mut MediaTextures<'a>,
    panel2_textures: &mut MediaTextures<'a>,
    panel3_textures: &mut MediaTextures<'a>,
    video_manager: &mut VideoManager,
    is_video_playing: &mut bool,
) -> Result<()> {
    // Stop current video
    video_manager.stop();
    *is_video_playing = false;

    let playlist = state.playlist.read().await;
    if playlist.is_empty() {
        return Ok(());
    }

    let step = renderer.current_layout.image_count();

    // Go to previous index (wrap around)
    let mut index = state.current_index.write().await;
    *index = if *index < step {
        playlist.len().saturating_sub(step)
    } else {
        *index - step
    };
    let prev_index = *index;
    drop(index);

    let media = &playlist[prev_index];
    tracing::debug!("Going to previous: {} ({})", media.id, media.media_type);

    state.preload_media_safe(media).await?;
    let cache = state.cache.read().await;
    let new_textures =
        state
            .asset_manager
            .load_textures(renderer, texture_creator, media, &cache)?;
    drop(cache);

    *next_textures = None;
    *current_textures = new_textures;

    // Load extra panels for multi-image layouts (cut transition for previous)
    if step >= 2 {
        let idx = (prev_index + 1) % playlist.len();
        let m = playlist[idx].clone();
        state.preload_media_safe(&m).await?;
        let cache = state.cache.read().await;
        *right_textures =
            state
                .asset_manager
                .load_textures(renderer, texture_creator, &m, &cache)?;
        drop(cache);
    }
    if step >= 3 {
        let idx = (prev_index + 2) % playlist.len();
        let m = playlist[idx].clone();
        state.preload_media_safe(&m).await?;
        let cache = state.cache.read().await;
        *panel2_textures =
            state
                .asset_manager
                .load_textures(renderer, texture_creator, &m, &cache)?;
        drop(cache);
    }
    if step >= 4 {
        let idx = (prev_index + 3) % playlist.len();
        let m = playlist[idx].clone();
        drop(playlist);
        state.preload_media_safe(&m).await?;
        let cache = state.cache.read().await;
        *panel3_textures =
            state
                .asset_manager
                .load_textures(renderer, texture_creator, &m, &cache)?;
        drop(cache);
    } else {
        drop(playlist);
    }

    // Touch cache for left panel
    let playlist = state.playlist.read().await;
    let media = &playlist[prev_index % playlist.len()];
    let mut cache = state.cache.write().await;
    cache.touch(&media.id, AssetType::Display);

    // Start video if applicable
    start_video_if_applicable(media, &cache, video_manager, is_video_playing);

    Ok(())
}

/// Handle a realtime event.
async fn handle_realtime_event(state: &AppState, event: RealtimeEvent) {
    match event {
        RealtimeEvent::Connected => {
            tracing::info!("Realtime connected");
        }
        RealtimeEvent::Disconnected => {
            tracing::warn!("Realtime disconnected");
        }
        RealtimeEvent::RefreshNeeded => {
            tracing::info!("Refreshing playlist...");
            match state.fetch_playlist().await {
                Ok(playlist) => {
                    // Save playlist to cache
                    {
                        let cache = state.cache.read().await;
                        if let Err(e) = cache.save_playlist(&playlist) {
                            tracing::warn!("Failed to save playlist: {}", e);
                        }
                    }

                    // Clean up orphaned cache entries
                    {
                        let mut cache = state.cache.write().await;
                        cache.cleanup_orphans(&playlist);
                        let stats = cache.stats();
                        tracing::debug!(
                            "Cache cleanup done: {:.1}MB used, {} items",
                            stats.current_size as f64 / 1024.0 / 1024.0,
                            stats.item_count
                        );
                    }

                    *state.playlist.write().await = playlist;
                }
                Err(e) => {
                    tracing::error!("Failed to refresh playlist: {}", e);
                }
            }
        }
        RealtimeEvent::MediaCreated(media) => {
            tracing::info!("Media created: {}", media.id);
            let mut playlist = state.playlist.write().await;
            playlist.push(media);

            let cache = state.cache.read().await;
            let _ = cache.save_playlist(&playlist);
        }
        RealtimeEvent::MediaUpdated(media) => {
            tracing::info!("Media updated: {}", media.id);
            let mut playlist = state.playlist.write().await;
            if let Some(pos) = playlist.iter().position(|m| m.id == media.id) {
                playlist[pos] = media;
            } else {
                playlist.push(media);
            }

            let cache = state.cache.read().await;
            let _ = cache.save_playlist(&playlist);
        }
        RealtimeEvent::MediaDeleted(id) => {
            tracing::info!("Media deleted: {}", id);
            let mut playlist = state.playlist.write().await;
            playlist.retain(|m| m.id != id);

            let cache = state.cache.read().await;
            let _ = cache.save_playlist(&playlist);
        }
        RealtimeEvent::ConfigChanged => {
            tracing::info!("Device config changed — restarting to apply new settings");
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                let exe = std::env::current_exe()
                    .unwrap_or_else(|_| std::path::PathBuf::from("frame-viewer"));
                let err = std::process::Command::new(&exe)
                    .args(std::env::args_os().skip(1))
                    .exec();
                tracing::error!("Re-exec failed: {} — falling back to exit", err);
            }
            std::process::exit(0);
        }
        // Remote control events are handled inline in the render loop, not here.
        RealtimeEvent::RemoteNext
        | RealtimeEvent::RemotePrev
        | RealtimeEvent::RemoteRandom
        | RealtimeEvent::RemotePause { .. }
        | RealtimeEvent::RemoteResume
        | RealtimeEvent::RemoteToggleInfo
        | RealtimeEvent::RemoteToggleLocationInfo
        | RealtimeEvent::RemoteTagFilter { .. }
        | RealtimeEvent::RemoteTagFilterClear => {}
    }
}

fn start_video_if_applicable(
    media: &Media,
    cache: &Cache,
    video_manager: &mut VideoManager,
    is_video_playing: &mut bool,
) {
    *is_video_playing = false;
    if media.is_video() {
        if let Some(video_path) = cache.get_cached_path(&media.id, AssetType::Video) {
            if video_path.exists() {
                match video_manager.play_video(&video_path, media.duration) {
                    Ok(()) => {
                        *is_video_playing = true;
                    }
                    Err(e) => {
                        tracing::warn!("Failed to start video: {}", e);
                    }
                }
            }
        }
    }
}

/// Format an ISO date-time string ("2026-04-24T13:45:00") as "1:45 PM, 04 April 2026".
/// If there is no time component, returns "04 April 2026".
fn format_taken_at(s: &str) -> String {
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];

    // Handle both "2026-04-24T13:45:00" and "2026-04-24 13:45:29.000Z"
    let (date_part, time_part) = if let Some(idx) = s.find(['T', ' ']) {
        let time_raw = &s[idx + 1..];
        // Strip trailing milliseconds and timezone suffix (e.g. ".000Z")
        let time_clean = time_raw
            .find('.')
            .map(|i| &time_raw[..i])
            .unwrap_or(time_raw);
        (&s[..idx], Some(time_clean))
    } else {
        (s, None)
    };

    let parts: Vec<&str> = date_part.split('-').collect();
    if parts.len() < 3 {
        return s.to_string();
    }
    let year = parts[0];
    let month: usize = parts[1].parse().unwrap_or(0);
    let day: u32 = parts[2].parse().unwrap_or(0);
    if month == 0 || month > 12 || day == 0 {
        return s.to_string();
    }
    let date_str = format!("{:02} {} {}", day, MONTHS[month - 1], year);

    if let Some(t) = time_part {
        let tparts: Vec<&str> = t.split(':').collect();
        if let (Some(hh), Some(mm)) = (tparts.first(), tparts.get(1)) {
            if let (Ok(h), Ok(m)) = (hh.parse::<u32>(), mm.parse::<u32>()) {
                let period = if h < 12 { "AM" } else { "PM" };
                let h12 = match h % 12 {
                    0 => 12,
                    v => v,
                };
                return format!("{}:{:02} {}, {}", h12, m, period, date_str);
            }
        }
    }

    date_str
}
