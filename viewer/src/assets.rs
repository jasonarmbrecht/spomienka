//! Asset management module for loading and preloading media.
//!
//! Handles downloading assets from PocketBase and loading them into textures.

use crate::cache::Cache;
use crate::renderer::{MediaTextures, Renderer};
use anyhow::Result;
use sdl2::render::TextureCreator;
use sdl2::video::WindowContext;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Represents a media item from the playlist.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
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
    /// Check if this is a video media type.
    pub fn is_video(&self) -> bool {
        self.media_type == "video"
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
            AssetType::Display | AssetType::Blur | AssetType::Poster => "jpg",
            AssetType::Video => "mp4",
        }
    }
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
        let url = match asset_type {
            AssetType::Display => media.display_url.as_deref(),
            AssetType::Blur => media.blur_url.as_deref(),
            AssetType::Video => media.video_url.as_deref(),
            AssetType::Poster => media.poster_url.as_deref(),
        };

        let Some(url) = url else {
            return Ok(None);
        };

        let full_url = self.full_url(url);

        // Check if already cached
        {
            let cache = self.cache.read().await;
            if let Some(path) = cache.get_cached_path(&media.id, asset_type) {
                if path.exists() {
                    return Ok(Some(path));
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

        // Load blur texture
        if let Some(blur_path) = cache.get_cached_path(&media.id, AssetType::Blur) {
            if blur_path.exists() {
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

        // Load display texture (or poster for videos)
        let display_asset = if media.is_video() {
            AssetType::Poster
        } else {
            AssetType::Display
        };

        if let Some(display_path) = cache.get_cached_path(&media.id, display_asset) {
            if display_path.exists() {
                match renderer.load_texture_from_file(texture_creator, &display_path) {
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

