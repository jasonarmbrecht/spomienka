//! Frame Viewer - Digital photo frame client for Raspberry Pi.
//!
//! Displays published media from PocketBase with transitions, caching, and realtime sync.

mod assets;
mod cache;
mod realtime;
mod renderer;
mod video;

use anyhow::{Context, Result};
use assets::{AssetManager, AssetType, Media, Preloader};
use cache::Cache;
use config::{Config, Environment, File};
use realtime::{spawn_realtime, RealtimeEvent};
use renderer::{MediaTextures, OverlayInfo, Renderer, Transition, UserAction};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
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

    /// Optional device API key for authentication
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
            .set_default("transition_duration_ms", default_transition_duration_ms() as i64)?
            .set_default("cache_dir", default_cache_dir())?
            .set_default("cache_size_limit_gb", default_cache_size_limit_gb() as i64)?
            .set_default("enable_realtime", default_enable_realtime())?
            .set_default("video_loop_threshold_sec", default_video_loop_threshold_sec() as f64)?
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
            device_api_key: self.device_api_key.clone().filter(|s| !s.is_empty()),
        }
    }
}

#[derive(Debug, Clone)]
struct AuthCreds {
    email: Option<String>,
    password: Option<String>,
    token: Option<String>,
    device_api_key: Option<String>,
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
}

impl AppState {
    async fn new(config: AppConfig) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .context("Failed to create HTTP client")?;

        let cache = Cache::new(
            config.cache_dir.clone().into(),
            config.cache_size_limit_gb,
        )?;
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
        })
    }

    /// Get the current auth token.
    async fn token(&self) -> Option<String> {
        self.auth_token.read().await.clone()
    }

    /// Fetch playlist from PocketBase.
    async fn fetch_playlist(&self) -> Result<Vec<Media>> {
        let creds = self.config.to_auth_creds();
        let mut token = self.auth_token.write().await;

        // Build filter with device scope if configured
        let filter = self.build_filter();
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
    fn build_filter(&self) -> String {
        let mut filter = "status='published'".to_string();

        if let Some(ref device_id) = self.config.device_id {
            let device_filter = format!(
                "(deviceScopes~'\"{}\"' || deviceScopes = [] || deviceScopes = null)",
                device_id
            );
            filter = format!(
                "({}) && {}",
                filter, device_filter
            );
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

        Err(anyhow::anyhow!("Unauthorized and no credentials to refresh"))
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
        // Priority 1: Device API key (used as bearer token directly)
        if let Some(ref device_key) = creds.device_api_key {
            tracing::debug!("Using device API key for authentication");
            return Ok(Some(device_key.clone()));
        }

        // Priority 2: Direct auth token
        if let Some(ref token) = creds.token {
            return Ok(Some(token.clone()));
        }

        // Priority 3: User email/password login
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

    /// Get the initial auth token.
    async fn init_auth(&self) -> Result<()> {
        let creds = self.config.to_auth_creds();

        let token = if let Some(token) = creds.token.clone() {
            Some(token)
        } else if creds.can_login() {
            self.refresh_token(&creds).await?
        } else {
            None
        };

        *self.auth_token.write().await = token;
        Ok(())
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
        
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Failed to fetch playlist after {} retries", max_retries)))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env().add_directive("frame_viewer=info".parse()?))
        .init();

    // Load configuration
    let config = AppConfig::load()?;

    tracing::info!("Starting frame-viewer");
    tracing::info!("  PocketBase URL: {}", config.pb_url);
    tracing::info!("  Interval: {}ms", config.interval_ms);
    tracing::info!("  Transition: {} ({}ms)", config.transition, config.transition_duration_ms);
    tracing::info!("  Cache: {} ({} GB limit)", config.cache_dir, config.cache_size_limit_gb);
    if let Some(ref device_id) = config.device_id {
        tracing::info!("  Device ID: {}", device_id);
    }

    // Initialize GStreamer for video
    video::VideoPlayer::init()?;

    // Create application state
    let state = Arc::new(AppState::new(config).await?);

    // Initialize auth
    state.init_auth().await?;

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

    // Shuffle if configured
    if state.config.shuffle {
        use rand::seq::SliceRandom;
        let mut playlist = state.playlist.write().await;
        playlist.shuffle(&mut rand::thread_rng());
    }

    // Start preloader for initial assets
    let preloader = Preloader::new(state.asset_manager.clone(), state.client.clone());
    let token = state.token().await;
    let playlist_clone = playlist.clone();

    // Full sync mode: preload all media on startup
    if state.config.full_sync && !playlist.is_empty() {
        tracing::info!("Full sync mode enabled - preloading all {} media items...", playlist.len());
        let sync_preloader = Preloader::new(state.asset_manager.clone(), state.client.clone());
        let sync_token = state.token().await;
        let sync_playlist = playlist.clone();
        
        // Run full sync in foreground so user knows when it's done
        sync_preloader.preload_all(&sync_playlist, sync_token.as_deref()).await;
        tracing::info!("Full sync complete");
    } else {
        // Preload first few items in background
        tokio::spawn(async move {
            preloader.preload_next(&playlist_clone, 0, 3, token.as_deref()).await;
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

/// Main render loop.
async fn run_render_loop(
    state: Arc<AppState>,
    realtime_rx: &mut Option<tokio::sync::mpsc::Receiver<RealtimeEvent>>,
) -> Result<()> {
    // Initialize renderer
    let transition = Transition::from_str(&state.config.transition);
    let mut renderer = Renderer::new(transition, state.config.transition_duration_ms)?;

    // Initialize video manager
    let mut video_manager = VideoManager::new(state.config.video_loop_threshold_sec);

    // Create texture creator
    let texture_creator = renderer.texture_creator();

    // Current and next textures
    let mut current_textures = MediaTextures::new();
    let mut next_textures: Option<MediaTextures> = None;

    // Timing
    let mut last_advance = Instant::now();
    let slide_duration = Duration::from_millis(state.config.interval_ms);

    // Track if we're showing video
    let mut is_video_playing = false;
    
    // Overlay state
    let mut overlay_visible = false;
    let mut is_paused = false;
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
                    &mut video_manager,
                    &mut is_video_playing,
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

        // Process realtime events
        if let Some(ref mut rx) = realtime_rx {
            while let Ok(event) = rx.try_recv() {
                match &event {
                    RealtimeEvent::Connected => is_realtime_connected = true,
                    RealtimeEvent::Disconnected => is_realtime_connected = false,
                    _ => {}
                }
                handle_realtime_event(&state, event).await;
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
                    &mut video_manager,
                    &mut is_video_playing,
                )
                .await?;
                last_advance = Instant::now();
            }
        }

        // Update transition
        let should_swap = renderer.update_transition();
        if should_swap {
            // Swap current and next textures
            if let Some(next) = next_textures.take() {
                current_textures = next;
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
                &mut video_manager,
                &mut is_video_playing,
            )
            .await?;
            last_advance = Instant::now();
        }

        // Render
        renderer.render(&mut current_textures, next_textures.as_mut())?;

        // Render overlay if visible
        if overlay_visible {
            let overlay_info = build_overlay_info(
                &state,
                &video_manager,
                is_video_playing,
                is_paused,
                is_realtime_connected,
            )
            .await;
            if let Err(e) = renderer.render_overlay(&overlay_info) {
                tracing::warn!("Failed to render overlay: {}", e);
            }
        }

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
        video_duration: if is_video_playing { video_manager.duration() } else { None },
        video_position: if is_video_playing { video_manager.position() } else { None },
    }
}

/// Load the current item into textures.
async fn load_current_item<'a>(
    state: &AppState,
    renderer: &mut Renderer,
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
    let token = state.token().await;
    state
        .asset_manager
        .preload_media(media, &state.client, token.as_deref())
        .await?;

    // Load textures
    let cache = state.cache.read().await;
    *textures = state
        .asset_manager
        .load_textures(renderer, texture_creator, media, &cache)?;

    // Touch cache entries for LRU
    drop(cache);
    let mut cache = state.cache.write().await;
    cache.touch(&media.id, AssetType::Display);
    cache.touch(&media.id, AssetType::Blur);

    // Start video if applicable
    *is_video_playing = false;
    if media.is_video() {
        if let Some(video_path) = cache.get_cached_path(&media.id, AssetType::Video) {
            if video_path.exists() {
                match video_manager.play_video(&video_path, media.duration) {
                    Ok(()) => {
                        *is_video_playing = true;
                        tracing::debug!("Started video playback");
                    }
                    Err(e) => {
                        tracing::warn!("Failed to start video: {}", e);
                    }
                }
            }
        }
    }

    Ok(())
}

/// Advance to the next item in the playlist.
async fn advance_to_next<'a>(
    state: &AppState,
    renderer: &mut Renderer,
    texture_creator: &'a sdl2::render::TextureCreator<sdl2::video::WindowContext>,
    current_textures: &mut MediaTextures<'a>,
    next_textures: &mut Option<MediaTextures<'a>>,
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

    // Advance index
    let mut index = state.current_index.write().await;
    *index = (*index + 1) % playlist.len();
    let next_index = *index;
    drop(index);

    let media = &playlist[next_index];
    tracing::debug!("Advancing to: {} ({})", media.id, media.media_type);

    // Preload in background
    let preloader = Preloader::new(state.asset_manager.clone(), state.client.clone());
    let token = state.token().await;
    let playlist_clone = playlist.clone();
    let next_idx = next_index;

    tokio::spawn(async move {
        preloader.preload_next(&playlist_clone, next_idx, 2, token.as_deref()).await;
    });

    // Ensure current item is cached
    let token = state.token().await;
    state
        .asset_manager
        .preload_media(media, &state.client, token.as_deref())
        .await?;

    // Load next textures
    let cache = state.cache.read().await;
    let new_textures = state
        .asset_manager
        .load_textures(renderer, texture_creator, media, &cache)?;
    drop(cache);

    // Prepare next frame and kick off transition if needed
    *next_textures = Some(new_textures);

    match Transition::from_str(&state.config.transition) {
        Transition::Cut => {
            if let Some(next) = next_textures.take() {
                *current_textures = next;
            }
        }
        _ => {
            renderer.start_transition();
        }
    }

    // Touch cache
    let mut cache = state.cache.write().await;
    cache.touch(&media.id, AssetType::Display);
    cache.touch(&media.id, AssetType::Blur);

    // Start video if applicable
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

    Ok(())
}

/// Go to the previous item in the playlist.
async fn go_to_previous<'a>(
    state: &AppState,
    renderer: &mut Renderer,
    texture_creator: &'a sdl2::render::TextureCreator<sdl2::video::WindowContext>,
    current_textures: &mut MediaTextures<'a>,
    next_textures: &mut Option<MediaTextures<'a>>,
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

    // Go to previous index (wrap around)
    let mut index = state.current_index.write().await;
    *index = if *index == 0 {
        playlist.len() - 1
    } else {
        *index - 1
    };
    let prev_index = *index;
    drop(index);

    let media = &playlist[prev_index];
    tracing::debug!("Going to previous: {} ({})", media.id, media.media_type);

    // Ensure current item is cached
    let token = state.token().await;
    state
        .asset_manager
        .preload_media(media, &state.client, token.as_deref())
        .await?;

    // Load textures
    let cache = state.cache.read().await;
    let new_textures = state
        .asset_manager
        .load_textures(renderer, texture_creator, media, &cache)?;
    drop(cache);

    // Use cut transition for manual navigation
    *next_textures = None;
    *current_textures = new_textures;

    // Touch cache
    let mut cache = state.cache.write().await;
    cache.touch(&media.id, AssetType::Display);
    cache.touch(&media.id, AssetType::Blur);

    // Start video if applicable
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
    }
}
