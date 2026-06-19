//! Asset management module for loading and preloading media.
//!
//! Handles downloading assets from PocketBase and loading them into textures.

use crate::cache::Cache;
use crate::renderer::{MediaTextures, Renderer};
use anyhow::Result;
use sdl2::render::TextureCreator;
use sdl2::video::WindowContext;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Represents a media item from the playlist.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub collection_id: Option<String>,
    pub collection_name: Option<String>,
    /// Original uploaded file — used as fallback when processed URLs are empty.
    pub file: Option<String>,
    #[serde(rename = "type")]
    pub media_type: String,
    pub display_url: Option<String>,
    pub blur_url: Option<String>,
    pub video_url: Option<String>,
    pub poster_url: Option<String>,
    pub duration: Option<f32>,
    pub tags: Option<serde_json::Value>,
    pub device_scopes: Option<serde_json::Value>,
}

impl Media {
    /// Build the PocketBase URL for the raw uploaded file.
    /// Used as fallback when processed URLs (displayUrl, blurUrl) are empty.
    pub fn raw_file_url(&self) -> Option<String> {
        let file = self.file.as_deref().filter(|s| !s.is_empty())?;
        let col = self
            .collection_name
            .as_deref()
            .or(self.collection_id.as_deref())
            .filter(|s| !s.is_empty())
            .unwrap_or("media");
        Some(format!("/api/files/{}/{}/{}", col, self.id, file))
    }

    /// Check if this is a video media type.
    pub fn is_video(&self) -> bool {
        self.media_type == "video"
    }

    /// Return the processed URL for the given asset type, or None if absent/empty.
    pub fn url_for_asset(&self, asset_type: AssetType) -> Option<&str> {
        match asset_type {
            AssetType::Display => self.display_url.as_deref(),
            AssetType::Blur => self.blur_url.as_deref(),
            AssetType::Video => self.video_url.as_deref(),
            AssetType::Poster => self.poster_url.as_deref(),
        }
        .filter(|s| !s.is_empty())
    }
}

/// Asset types that can be cached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AssetType {
    Display,
    Blur,
    Video,
    Poster,
}

impl AssetType {
    pub fn as_str(&self) -> &'static str {
        match self {
            AssetType::Display => "display",
            AssetType::Blur => "blur",
            AssetType::Video => "video",
            AssetType::Poster => "poster",
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            AssetType::Display | AssetType::Blur | AssetType::Poster => "png",
            AssetType::Video => "mp4",
        }
    }
}

fn is_image_asset(asset_type: AssetType) -> bool {
    matches!(
        asset_type,
        AssetType::Display | AssetType::Blur | AssetType::Poster
    )
}

fn is_supported_image_file(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };

    bytes.starts_with(&[0xff, 0xd8, 0xff])
        || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
}

/// Manages asset loading and preloading.
pub struct AssetManager {
    cache: Arc<RwLock<Cache>>,
    pb_url: String,
}

impl AssetManager {
    /// Create a new asset manager.
    pub fn new(cache: Arc<RwLock<Cache>>, pb_url: String) -> Self {
        Self { cache, pb_url }
    }

    /// Get the full URL for an asset.
    pub fn full_url(&self, relative_url: &str) -> String {
        if relative_url.starts_with("http://") || relative_url.starts_with("https://") {
            relative_url.to_string()
        } else {
            format!("{}{}", self.pb_url, relative_url)
        }
    }

    /// Ensure an asset is cached, downloading if necessary.
    pub async fn ensure_cached(
        &self,
        media: &Media,
        asset_type: AssetType,
        client: &reqwest::Client,
        token: Option<&str>,
    ) -> Result<Option<PathBuf>> {
        let processed_url = media.url_for_asset(asset_type);

        // Fall back to the raw original file for still images and for video playback
        // when backend processing has not produced derived URLs yet. A missing video
        // poster should remain missing; caching the MP4 as a JPEG only produces
        // blank textures and noisy image-load warnings.
        let fallback;
        let url = match processed_url {
            Some(u) => u,
            None => match asset_type {
                AssetType::Display if !media.is_video() => {
                    fallback = media.raw_file_url();
                    match fallback.as_deref() {
                        Some(u) => u,
                        None => return Ok(None),
                    }
                }
                AssetType::Video if media.is_video() => {
                    fallback = media.raw_file_url();
                    match fallback.as_deref() {
                        Some(u) => u,
                        None => return Ok(None),
                    }
                }
                AssetType::Display | AssetType::Blur | AssetType::Video | AssetType::Poster => {
                    return Ok(None);
                }
            },
        };

        let full_url = self.full_url(url);

        // Check if already cached
        {
            let cache = self.cache.read().await;
            if let Some(path) = cache.get_cached_path(&media.id, asset_type) {
                if path.exists() {
                    if is_image_asset(asset_type) && !is_supported_image_file(&path) {
                        tracing::warn!(
                            "Discarding invalid cached {} image for {}: {:?}",
                            asset_type.as_str(),
                            media.id,
                            path
                        );
                        if let Err(e) = std::fs::remove_file(&path) {
                            tracing::warn!("Failed to remove invalid cached image: {}", e);
                        }
                    } else {
                        return Ok(Some(path));
                    }
                }
            }
        }

        // Download and cache
        let mut cache = self.cache.write().await;
        let path = cache
            .download_and_cache(client, &full_url, &media.id, asset_type, token)
            .await?;

        Ok(Some(path))
    }

    /// Preload all assets for a media item.
    pub async fn preload_media(
        &self,
        media: &Media,
        client: &reqwest::Client,
        token: Option<&str>,
    ) -> Result<()> {
        // Always try to cache display and blur
        if let Err(e) = self
            .ensure_cached(media, AssetType::Display, client, token)
            .await
        {
            tracing::warn!("Failed to cache display for {}: {}", media.id, e);
        }

        if let Err(e) = self
            .ensure_cached(media, AssetType::Blur, client, token)
            .await
        {
            tracing::warn!("Failed to cache blur for {}: {}", media.id, e);
        }

        // For videos, also cache poster and video
        if media.is_video() {
            if let Err(e) = self
                .ensure_cached(media, AssetType::Poster, client, token)
                .await
            {
                tracing::warn!("Failed to cache poster for {}: {}", media.id, e);
            }

            if let Err(e) = self
                .ensure_cached(media, AssetType::Video, client, token)
                .await
            {
                tracing::warn!("Failed to cache video for {}: {}", media.id, e);
            }
        }

        Ok(())
    }

    /// Load textures for a media item into SDL2 textures.
    pub fn load_textures<'a>(
        &self,
        renderer: &Renderer,
        texture_creator: &'a TextureCreator<WindowContext>,
        media: &Media,
        cache: &Cache,
    ) -> Result<MediaTextures<'a>> {
        let mut textures = MediaTextures::new();

        // Load blur texture (pre-generated by the backend)
        if let Some(blur_path) = cache.get_cached_path(&media.id, AssetType::Blur) {
            if blur_path.exists() {
                if !is_supported_image_file(&blur_path) {
                    tracing::warn!("Discarding invalid cached blur image: {:?}", blur_path);
                    if let Err(e) = std::fs::remove_file(&blur_path) {
                        tracing::warn!("Failed to remove invalid cached blur image: {}", e);
                    }
                } else {
                    match renderer.load_texture_from_file(texture_creator, &blur_path) {
                        Ok((tex, _, _)) => {
                            textures.blur = Some(tex);
                        }
                        Err(e) => {
                            tracing::warn!("Failed to load blur texture: {}", e);
                        }
                    }
                }
            }
        }

        // Load display texture (or poster for videos)
        let display_asset = if media.is_video() {
            AssetType::Poster
        } else {
            AssetType::Display
        };

        let display_path = cache.get_cached_path(&media.id, display_asset);

        if let Some(ref path) = display_path {
            if path.exists() {
                if !is_supported_image_file(path) {
                    tracing::warn!("Discarding invalid cached display image: {:?}", path);
                    if let Err(e) = std::fs::remove_file(path) {
                        tracing::warn!("Failed to remove invalid cached display image: {}", e);
                    }
                } else {
                    match renderer.load_texture_from_file(texture_creator, path) {
                        Ok((tex, width, height)) => {
                            textures.display = Some(tex);
                            textures.display_size = Some((width, height));
                        }
                        Err(e) => {
                            tracing::warn!("Failed to load display texture: {}", e);
                        }
                    }
                }
            }
        }

        // If no server-side blur exists, generate one on the CPU using a real Gaussian blur.
        // This runs once per image load (~40ms) and is cached for the duration of the slide.
        if textures.blur.is_none() {
            if let Some(ref path) = display_path {
                if path.exists() {
                    let t = std::time::Instant::now();
                    match renderer.generate_blur_texture(texture_creator, path) {
                        Ok(tex) => {
                            tracing::debug!("Generated Gaussian blur in {:?}", t.elapsed());
                            textures.blur = Some(tex);
                        }
                        Err(e) => {
                            tracing::warn!("Failed to generate blur texture: {}", e);
                        }
                    }
                }
            }
        }

        Ok(textures)
    }
}

/// Background preloader that downloads assets ahead of time.
pub struct Preloader {
    asset_manager: Arc<AssetManager>,
    client: reqwest::Client,
}

impl Preloader {
    /// Create a new preloader.
    pub fn new(asset_manager: Arc<AssetManager>, client: reqwest::Client) -> Self {
        Self {
            asset_manager,
            client,
        }
    }

    /// Preload the next N items in the playlist.
    pub async fn preload_next(
        &self,
        playlist: &[Media],
        current_index: usize,
        count: usize,
        token: Option<&str>,
    ) {
        // Nothing to do if the playlist is empty; avoids modulo by zero.
        if playlist.is_empty() {
            tracing::debug!("Preload skipped: empty playlist");
            return;
        }

        for i in 1..=count {
            let next_index = (current_index + i) % playlist.len();
            if next_index == current_index {
                break;
            }

            let media = &playlist[next_index];
            tracing::debug!("Preloading media: {}", media.id);

            if let Err(e) = self
                .asset_manager
                .preload_media(media, &self.client, token)
                .await
            {
                tracing::warn!("Failed to preload {}: {}", media.id, e);
            }
        }
    }

    /// Preload all items in the playlist (for initial sync).
    pub async fn preload_all(&self, playlist: &[Media], token: Option<&str>) {
        tracing::info!("Preloading {} media items...", playlist.len());
        for (i, media) in playlist.iter().enumerate() {
            tracing::debug!("Preloading {}/{}: {}", i + 1, playlist.len(), media.id);
            if let Err(e) = self
                .asset_manager
                .preload_media(media, &self.client, token)
                .await
            {
                tracing::warn!("Failed to preload {}: {}", media.id, e);
            }
        }
        tracing::info!("Preloading complete");
    }
}
