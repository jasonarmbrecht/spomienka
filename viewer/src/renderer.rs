//! SDL2-based rendering module for the frame viewer.
//!
//! Handles window creation, texture management, and rendering with transitions.

use anyhow::{Context, Result};
use sdl2::event::Event;
use sdl2::keyboard::Keycode;
use sdl2::pixels::{Color, PixelFormatEnum};
use sdl2::rect::Rect;
use sdl2::render::{Canvas, Texture, TextureCreator};
use sdl2::ttf::Sdl2TtfContext;
use sdl2::video::{Window, WindowContext};
use std::path::Path;
use std::time::{Duration, Instant};

/// Transition types supported by the renderer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Transition {
    /// Instant switch, no transition effect.
    Cut,
    /// Fade from black to image.
    Fade,
    /// Crossfade between current and next image.
    Crossfade,
}

impl Transition {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "fade" => Transition::Fade,
            "crossfade" => Transition::Crossfade,
            _ => Transition::Cut,
        }
    }
}

/// Layout kind discriminant — used for history tracking (no positional info).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlideLayoutKind {
    Single,
    DualPortrait,
    PortraitDualLandscape,
    QuadLandscape,
    DualSquare,
    SquarePortrait,
}

/// Active slide layout — captures kind and which slot goes on which side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlideLayout {
    /// One image, full-screen (any orientation in single mode, landscape in dynamic).
    Single,
    /// Two portrait (or square) images side by side.
    DualPortrait { flipped: bool },
    /// One portrait image + two stacked landscape images. `portrait_right`: portrait on right.
    PortraitDualLandscape { portrait_right: bool },
    /// Four landscape images: two stacked left, two stacked right. `flipped`: right pair is slots 0&1.
    QuadLandscape { flipped: bool },
    /// Two square images side by side.
    DualSquare { flipped: bool },
    /// One square image + one portrait image. `square_right`: square on the right.
    SquarePortrait { square_right: bool },
}

impl SlideLayout {
    pub fn kind(&self) -> SlideLayoutKind {
        match self {
            SlideLayout::Single => SlideLayoutKind::Single,
            SlideLayout::DualPortrait { .. } => SlideLayoutKind::DualPortrait,
            SlideLayout::PortraitDualLandscape { .. } => SlideLayoutKind::PortraitDualLandscape,
            SlideLayout::QuadLandscape { .. } => SlideLayoutKind::QuadLandscape,
            SlideLayout::DualSquare { .. } => SlideLayoutKind::DualSquare,
            SlideLayout::SquarePortrait { .. } => SlideLayoutKind::SquarePortrait,
        }
    }

    /// Number of images consumed by this layout.
    pub fn image_count(&self) -> usize {
        match self {
            SlideLayout::Single => 1,
            SlideLayout::DualPortrait { .. } => 2,
            SlideLayout::DualSquare { .. } => 2,
            SlideLayout::SquarePortrait { .. } => 2,
            SlideLayout::PortraitDualLandscape { .. } => 3,
            SlideLayout::QuadLandscape { .. } => 4,
        }
    }

    pub fn is_multi(&self) -> bool {
        self.image_count() > 1
    }
}

/// State of the current transition animation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TransitionState {
    /// No transition in progress, displaying current image.
    Idle,
    /// Transitioning out from current image.
    TransitioningOut { progress: f32 },
    /// Transitioning in to next image.
    TransitioningIn { progress: f32 },
}

/// Holds textures for a single media item.
pub struct MediaTextures<'a> {
    /// The main display image/video frame.
    pub display: Option<Texture<'a>>,
    /// The blurred background image.
    pub blur: Option<Texture<'a>>,
    /// Original dimensions of the display image.
    pub display_size: Option<(u32, u32)>,
}

impl<'a> MediaTextures<'a> {
    pub fn new() -> Self {
        Self {
            display: None,
            blur: None,
            display_size: None,
        }
    }
}

/// Specific user actions from keyboard/remote input.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum UserAction {
    /// No action, continue normally.
    None,
    /// Quit the application.
    Quit,
    /// Toggle pause (for videos).
    TogglePause,
    /// Skip to next media.
    Next,
    /// Go to previous media.
    Previous,
    /// Force playlist refresh.
    Refresh,
    /// Toggle overlay visibility.
    ToggleOverlay,
}

/// Information to display in the overlay.
#[derive(Debug, Clone, Default)]
pub struct OverlayInfo {
    /// Whether connected to PocketBase.
    pub is_connected: bool,
    /// Whether currently offline (using cache).
    pub is_offline: bool,
    /// Current media index (1-based for display).
    pub current_index: usize,
    /// Total media count.
    pub total_count: usize,
    /// Current media title/ID.
    pub media_title: String,
    /// Cache usage in bytes.
    pub cache_used: u64,
    /// Cache max size in bytes.
    pub cache_max: u64,
    /// Cache item count.
    pub cache_items: usize,
    /// Whether current media is a video.
    pub is_video: bool,
    /// Whether video is paused.
    pub is_paused: bool,
    /// Remaining seconds on a timed pause (None = not paused or manual pause).
    pub pause_secs_remaining: Option<u64>,
    /// Video duration in seconds.
    pub video_duration: Option<f32>,
    /// Video position in seconds.
    pub video_position: Option<f32>,
}

/// Information shown in the media info overlay (title, description, tags, etc.).
#[derive(Debug, Clone, Default)]
pub struct MediaInfoOverlay {
    pub title: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub tags: Vec<String>,
    pub taken_at: Option<String>,
    pub dimensions: Option<(u32, u32)>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub focal_length: Option<String>,
    pub f_number: Option<String>,
    pub exposure_time: Option<String>,
    pub iso: Option<String>,
}

/// The main renderer struct.
pub struct Renderer<'ttf> {
    canvas: Canvas<Window>,
    event_pump: sdl2::EventPump,
    screen_width: u32,
    screen_height: u32,
    transition_type: Transition,
    transition_duration_ms: u32,
    transition_state: TransitionState,
    transition_start: Option<Instant>,
    pub blur_background: bool,
    pub current_layout: SlideLayout,
    /// Layout for the incoming slide during a transition — `None` when idle.
    /// `current_layout` continues to describe the outgoing panels (still on
    /// screen, fading out) until the swap point, at which point it's set to
    /// this value and this is cleared.
    incoming_layout: Option<SlideLayout>,
    show_clock: bool,
    clock_offset_x: i32,
    clock_offset_y: i32,
    max_texture_dim: u32,
    font_overlay: Option<sdl2::ttf::Font<'ttf, 'static>>,
    font_info: Option<sdl2::ttf::Font<'ttf, 'static>>,
    font_clock: Option<sdl2::ttf::Font<'ttf, 'static>>,
    font_discovery_small: Option<sdl2::ttf::Font<'ttf, 'static>>,
    font_discovery_label: Option<sdl2::ttf::Font<'ttf, 'static>>,
    font_discovery_pin: Option<sdl2::ttf::Font<'ttf, 'static>>,
    /// Rects of the last rendered image(s), used to align info overlays.
    last_image_rects: [Option<Rect>; 4],
}

const CLOCK_FONT_BYTES: &[u8] = include_bytes!("../assets/fonts/BodoniModa-Regular.ttf");

/// System fonts used for utility overlays and discovery text.
const FONT_PATHS: &[&str] = &[
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:\\Windows\\Fonts\\arial.ttf",
];

impl<'ttf> Renderer<'ttf> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ttf_context: &'ttf Sdl2TtfContext,
        transition: Transition,
        transition_duration_ms: u32,
        fullscreen: bool,
        blur_background: bool,
        show_clock: bool,
        clock_offset_x: i32,
        clock_offset_y: i32,
        initial_layout: SlideLayout,
    ) -> Result<Self> {
        let sdl_context = sdl2::init().map_err(|e| anyhow::anyhow!("SDL init failed: {}", e))?;

        // Enable linear filtering globally for smooth scaling (fixes pixel mosaic on blur)
        sdl2::hint::set("SDL_RENDER_SCALE_QUALITY", "1");

        let video_subsystem = sdl_context
            .video()
            .map_err(|e| anyhow::anyhow!("SDL video init failed: {}", e))?;

        // Get display mode for resolution
        let display_mode = video_subsystem
            .desktop_display_mode(0)
            .map_err(|e| anyhow::anyhow!("Failed to get display mode: {}", e))?;

        let (screen_width, screen_height) = if fullscreen {
            (display_mode.w as u32, display_mode.h as u32)
        } else {
            (1280, 720)
        };

        tracing::info!(
            "Creating {} window: {}x{}",
            if fullscreen { "fullscreen" } else { "windowed" },
            screen_width,
            screen_height
        );

        let mut window_builder =
            video_subsystem.window("Frame Viewer", screen_width, screen_height);
        if fullscreen {
            window_builder.fullscreen_desktop();
        } else {
            window_builder.resizable();
        }
        let window = window_builder.build().context("Failed to create window")?;

        let mut canvas = window
            .into_canvas()
            .accelerated()
            .present_vsync()
            .target_texture()
            .build()
            .context("Failed to create canvas")?;

        // Enable blending for overlay
        canvas.set_blend_mode(sdl2::render::BlendMode::Blend);

        // Cap decoded image dimensions to what the GPU can actually turn into a
        // texture. Oversized textures (e.g. modern phone photos with no
        // server-side downscale) silently fail create_texture_streaming on some
        // GPUs (observed on Raspberry Pi 4's VideoCore VI), leaving only the
        // capped blur-background layer visible. Fall back to a conservative
        // value if the driver reports 0 (unknown).
        let renderer_info = canvas.info();
        let max_texture_dim = {
            let reported = renderer_info
                .max_texture_width
                .min(renderer_info.max_texture_height);
            if reported == 0 {
                4096
            } else {
                reported
            }
        };
        tracing::info!("Max GPU texture dimension: {}", max_texture_dim);

        // Hide cursor only in fullscreen kiosk mode
        sdl_context.mouse().show_cursor(!fullscreen);

        // Clear to black initially
        canvas.set_draw_color(sdl2::pixels::Color::RGB(0, 0, 0));
        canvas.clear();
        canvas.present();

        // Use physical pixel dimensions for all rendering so that on HiDPI/Retina
        // displays we draw at full resolution rather than letting SDL2 upscale a
        // half-sized logical framebuffer (which causes a double-resampling blur).
        let (physical_width, physical_height) = canvas
            .output_size()
            .map_err(|e| anyhow::anyhow!("Failed to get canvas output size: {}", e))?;
        if physical_width != screen_width || physical_height != screen_height {
            tracing::info!(
                "HiDPI detected: logical {}x{} → physical {}x{}",
                screen_width,
                screen_height,
                physical_width,
                physical_height
            );
        }
        let screen_width = physical_width;
        let screen_height = physical_height;

        let event_pump = sdl_context
            .event_pump()
            .map_err(|e| anyhow::anyhow!("Failed to get event pump: {}", e))?;

        // Clock uses bundled Bodoni Moda (serif). Info and utility text use a system
        // sans-serif so overlay metadata is clean and easy to read.
        let font_path = Self::find_font_path();
        let font_clock = sdl2::rwops::RWops::from_bytes(CLOCK_FONT_BYTES)
            .ok()
            .and_then(|rwops| ttf_context.load_font_from_rwops(rwops, 76).ok());

        let (
            font_info,
            font_overlay,
            font_discovery_small,
            font_discovery_label,
            font_discovery_pin,
        ) = if let Some(path) = font_path {
            (
                ttf_context.load_font(&path, 18).ok(),
                ttf_context.load_font(&path, 24).ok(),
                ttf_context.load_font(&path, 28).ok(),
                ttf_context.load_font(&path, 36).ok(),
                ttf_context.load_font(&path, 96).ok(),
            )
        } else {
            (None, None, None, None, None)
        };

        Ok(Self {
            canvas,
            event_pump,
            screen_width,
            screen_height,
            transition_type: transition,
            transition_duration_ms,
            transition_state: TransitionState::Idle,
            transition_start: None,
            blur_background,
            current_layout: initial_layout,
            incoming_layout: None,
            show_clock,
            clock_offset_x,
            clock_offset_y,
            max_texture_dim,
            font_overlay,
            font_info,
            font_clock,
            font_discovery_small,
            font_discovery_label,
            font_discovery_pin,
            last_image_rects: [None; 4],
        })
    }

    /// Try to find a system font path.
    fn find_font_path() -> Option<std::path::PathBuf> {
        for path in FONT_PATHS {
            let p = std::path::Path::new(path);
            if p.exists() {
                tracing::debug!("Found font at: {}", path);
                return Some(p.to_path_buf());
            }
        }
        // Return None if no font found - we'll skip text rendering
        tracing::warn!("No system font found, overlay text will be disabled");
        None
    }

    /// Get the texture creator for loading textures.
    pub fn texture_creator(&self) -> TextureCreator<WindowContext> {
        self.canvas.texture_creator()
    }

    /// Load an image from a file path into a texture.
    pub fn load_texture_from_file<'a>(
        &self,
        texture_creator: &'a TextureCreator<WindowContext>,
        path: &Path,
    ) -> Result<(Texture<'a>, u32, u32)> {
        let img = image::ImageReader::open(path)
            .context("Failed to open image")?
            .with_guessed_format()
            .context("Failed to guess image format")?
            .decode()
            .context("Failed to open image")?;
        let mut rgba = img.to_rgba8();
        let (orig_width, orig_height) = rgba.dimensions();

        // Downscale if the decoded image exceeds what the GPU can texture —
        // otherwise create_texture_streaming fails below and only the (always
        // screen-capped) blur background ends up visible.
        if orig_width.max(orig_height) > self.max_texture_dim {
            use image::imageops::{resize, FilterType};
            let scale = self.max_texture_dim as f32 / orig_width.max(orig_height) as f32;
            let new_width = ((orig_width as f32 * scale).round() as u32).max(1);
            let new_height = ((orig_height as f32 * scale).round() as u32).max(1);
            tracing::info!(
                "Downscaling oversized image {} from {}x{} to {}x{} (max texture dim {})",
                path.display(),
                orig_width,
                orig_height,
                new_width,
                new_height,
                self.max_texture_dim
            );
            rgba = resize(&rgba, new_width, new_height, FilterType::Triangle);
        }
        let (width, height) = rgba.dimensions();

        let mut texture = texture_creator
            .create_texture_streaming(PixelFormatEnum::ABGR8888, width, height)
            .context("Failed to create texture")?;

        texture
            .with_lock(None, |buffer: &mut [u8], pitch: usize| {
                for y in 0..height as usize {
                    for x in 0..width as usize {
                        let pixel = rgba.get_pixel(x as u32, y as u32);
                        let offset = y * pitch + x * 4;
                        buffer[offset] = pixel[0]; // R
                        buffer[offset + 1] = pixel[1]; // G
                        buffer[offset + 2] = pixel[2]; // B
                        buffer[offset + 3] = pixel[3]; // A
                    }
                }
            })
            .map_err(|e| anyhow::anyhow!("Failed to update texture: {}", e))?;

        // Enable alpha blending for transitions
        texture.set_blend_mode(sdl2::render::BlendMode::Blend);

        Ok((texture, width, height))
    }

    /// Generate a proper Gaussian-blurred background texture from an image file.
    ///
    /// This runs entirely on the CPU using `image::imageops::blur` (true Gaussian),
    /// producing a clean, smooth result with zero visible pattern or banding.
    /// The result is sized to the full screen so the GPU just blits it directly.
    ///
    /// Performance on Raspberry Pi 4 (estimated):
    ///   - Downscale to 480x270:  ~3ms
    ///   - Gaussian blur σ=8:     ~4ms
    ///   - Upscale to 1080p:      ~9ms
    ///     Total: ~16ms, called once per image transition — imperceptible to the user.
    pub fn generate_blur_texture<'a>(
        &self,
        texture_creator: &'a TextureCreator<WindowContext>,
        path: &Path,
    ) -> Result<Texture<'a>> {
        use image::imageops::{self, FilterType};

        let img = image::ImageReader::open(path)
            .context("Failed to open image for blur")?
            .with_guessed_format()
            .context("Failed to guess image format for blur")?
            .decode()
            .context("Failed to open image for blur")?;

        // Step 1: Downscale to quarter-resolution to strip fine detail while
        // retaining enough colour structure for a faithful background.
        let small = imageops::resize(&img, 480, 270, FilterType::Triangle);

        // Step 2: Real Gaussian blur — σ=8 at 480x270 gives the same visual
        // softness as σ=12 at 256x144 with better colour fidelity.
        let blurred = imageops::blur(&small, 8.0);

        // Step 3: Upscale to full screen resolution with Triangle (bilinear) filter.
        // Since the blurred image has no detail, the upscale is perfectly smooth.
        let final_img = imageops::resize(
            &blurred,
            self.screen_width,
            self.screen_height,
            FilterType::Triangle,
        );

        // Step 4: Upload to a streaming SDL2 texture
        let rgba = image::DynamicImage::ImageRgba8(final_img).to_rgba8();
        let (w, h) = rgba.dimensions();

        let mut texture = texture_creator
            .create_texture_streaming(PixelFormatEnum::ABGR8888, w, h)
            .context("Failed to create blur texture")?;

        texture
            .with_lock(None, |buffer: &mut [u8], pitch: usize| {
                for y in 0..h as usize {
                    for x in 0..w as usize {
                        let pixel = rgba.get_pixel(x as u32, y as u32);
                        let offset = y * pitch + x * 4;
                        buffer[offset] = pixel[0]; // R
                        buffer[offset + 1] = pixel[1]; // G
                        buffer[offset + 2] = pixel[2]; // B
                        buffer[offset + 3] = pixel[3]; // A
                    }
                }
            })
            .map_err(|e| anyhow::anyhow!("Failed to upload blur texture: {}", e))?;

        texture.set_blend_mode(sdl2::render::BlendMode::Blend);
        Ok(texture)
    }

    /// Get the screen dimensions.
    #[allow(dead_code)]
    pub fn screen_size(&self) -> (u32, u32) {
        (self.screen_width, self.screen_height)
    }
    /// Create a streaming YUV (I420) texture for video frames. The GPU does
    /// YUV->RGB conversion during render, instead of paying for it in
    /// software every frame like an RGBA texture fed from CPU-converted
    /// pixels would.
    pub fn create_yuv_texture<'a>(
        &self,
        texture_creator: &'a TextureCreator<WindowContext>,
        width: u32,
        height: u32,
    ) -> Result<Texture<'a>> {
        let mut texture = texture_creator
            .create_texture_streaming(PixelFormatEnum::IYUV, width, height)
            .context("Failed to create YUV texture")?;

        texture.set_blend_mode(sdl2::render::BlendMode::Blend);

        Ok(texture)
    }

    /// Update an existing YUV streaming texture's planes in place (for video
    /// frames). Avoids the GPU alloc/free churn of creating a brand-new
    /// texture every frame — call this instead of `create_yuv_texture`
    /// whenever the texture's dimensions already match the incoming frame.
    #[allow(clippy::too_many_arguments)]
    pub fn update_yuv_texture(
        &self,
        texture: &mut Texture,
        y_plane: &[u8],
        y_stride: usize,
        u_plane: &[u8],
        u_stride: usize,
        v_plane: &[u8],
        v_stride: usize,
    ) -> Result<()> {
        texture
            .update_yuv(
                None, y_plane, y_stride, u_plane, u_stride, v_plane, v_stride,
            )
            .map_err(|e| anyhow::anyhow!("Failed to update YUV texture: {}", e))?;

        Ok(())
    }

    /// Calculate aspect-fit rectangle for displaying an image on the full screen.
    fn calculate_aspect_fit(&self, img_width: u32, img_height: u32) -> Rect {
        Self::fit_in_box(
            img_width,
            img_height,
            0,
            0,
            self.screen_width,
            self.screen_height,
        )
    }

    /// Aspect-fit an image within an arbitrary bounding box, centered.
    fn fit_in_box(img_w: u32, img_h: u32, bx: i32, by: i32, bw: u32, bh: u32) -> Rect {
        if img_w == 0 || img_h == 0 || bw == 0 || bh == 0 {
            return Rect::new(bx, by, bw, bh);
        }
        let img_ratio = img_w as f32 / img_h as f32;
        let box_ratio = bw as f32 / bh as f32;
        let (fw, fh) = if img_ratio > box_ratio {
            let fw = bw;
            let fh = (bw as f32 / img_ratio).round() as u32;
            (fw, fh)
        } else {
            let fh = bh;
            let fw = (bh as f32 * img_ratio).round() as u32;
            (fw, fh)
        };
        let x = bx + ((bw as i32 - fw as i32) / 2);
        let y = by + ((bh as i32 - fh as i32) / 2);
        Rect::new(x, y, fw.max(1), fh.max(1))
    }

    /// Like fit_in_box but snaps to the inner edge of the cell rather than centering.
    ///
    /// `snap_right`  — align image to the right  side of the cell (faces an adjacent image)
    /// `snap_bottom` — align image to the bottom side of the cell (faces an adjacent image)
    /// The opposite (outer) edge is left floating so the gap between adjacent images is always
    /// exactly the cell boundary, not inflated by letterbox padding.
    #[allow(clippy::too_many_arguments)]
    #[allow(dead_code)]
    fn fit_snap(
        img_w: u32,
        img_h: u32,
        bx: i32,
        by: i32,
        bw: u32,
        bh: u32,
        snap_right: bool,
        snap_bottom: bool,
    ) -> Rect {
        if img_w == 0 || img_h == 0 || bw == 0 || bh == 0 {
            return Rect::new(bx, by, bw.max(1), bh.max(1));
        }
        let img_ratio = img_w as f32 / img_h as f32;
        let box_ratio = bw as f32 / bh as f32;
        let (fw, fh) = if img_ratio > box_ratio {
            let fw = bw;
            (fw, (bw as f32 / img_ratio).round() as u32)
        } else {
            let fh = bh;
            ((bh as f32 * img_ratio).round() as u32, fh)
        };
        let x = if snap_right {
            bx + bw as i32 - fw as i32
        } else {
            bx
        };
        let y = if snap_bottom {
            by + bh as i32 - fh as i32
        } else {
            by
        };
        Rect::new(x, y, fw.max(1), fh.max(1))
    }

    /// Cover-mode fit: scale image to fill cell (no distortion), center-crop overflow.
    /// Returns `Some((dst_rect, src_rect))` if scale ≤ `max_scale` and crop fraction ≤
    /// `max_crop_frac` in both axes. Returns `None` — caller should use `fit_snap` fallback.
    #[allow(clippy::too_many_arguments)]
    fn fit_cover(
        img_w: u32,
        img_h: u32,
        bx: i32,
        by: i32,
        bw: u32,
        bh: u32,
        max_scale: f32,
        max_crop_frac: f32,
    ) -> Option<(Rect, Rect)> {
        if img_w == 0 || img_h == 0 || bw == 0 || bh == 0 {
            return None;
        }
        let scale = (bw as f64 / img_w as f64).max(bh as f64 / img_h as f64);
        if scale > max_scale as f64 {
            return None;
        }
        let scaled_w = (img_w as f64 * scale).round() as u32;
        let scaled_h = (img_h as f64 * scale).round() as u32;
        let crop_x_frac = scaled_w.saturating_sub(bw) as f32 / scaled_w as f32;
        let crop_y_frac = scaled_h.saturating_sub(bh) as f32 / scaled_h as f32;
        if crop_x_frac > max_crop_frac || crop_y_frac > max_crop_frac {
            return None;
        }
        let off_x = scaled_w.saturating_sub(bw) / 2;
        let off_y = scaled_h.saturating_sub(bh) / 2;
        let src_x = (off_x as f64 / scale).round() as i32;
        let src_y = (off_y as f64 / scale).round() as i32;
        let src_w = ((bw as f64) / scale).round() as u32;
        let src_h = ((bh as f64) / scale).round() as u32;
        Some((
            Rect::new(bx, by, bw, bh),
            Rect::new(src_x.max(0), src_y.max(0), src_w.max(1), src_h.max(1)),
        ))
    }

    /// Compute display rects for all panels in the given layout.
    ///
    /// Returns up to 4 Rects corresponding to slots 0–(image_count-1).
    /// For layouts with a side option (portrait_right, flipped, etc.) the slots
    /// are always ordered by playlist position; the side flag only controls which
    /// screen column they land in.
    pub(crate) fn compute_panel_rects(
        layout: SlideLayout,
        sw: u32,
        sh: u32,
        sizes: &[Option<(u32, u32)>; 4],
    ) -> Vec<(Rect, Option<Rect>)> {
        const GAP: u32 = 8;
        let natural_w_at_h = |size: Option<(u32, u32)>, h: u32| -> u32 {
            let (w, ih) = size.unwrap_or((h, h));
            if ih == 0 {
                h
            } else {
                ((h as f64 * w as f64 / ih as f64).round() as u32).max(1)
            }
        };

        match layout {
            SlideLayout::Single => {
                let r = Self::fit_in_box(
                    sizes[0].map(|s| s.0).unwrap_or(sw),
                    sizes[0].map(|s| s.1).unwrap_or(sh),
                    0,
                    0,
                    sw,
                    sh,
                );
                vec![(r, None)]
            }

            SlideLayout::DualPortrait { flipped } | SlideLayout::DualSquare { flipped } => {
                // Two images side by side, both at full screen height
                let nw0 = natural_w_at_h(sizes[0], sh);
                let nw1 = natural_w_at_h(sizes[1], sh);
                let total_natural = nw0 + GAP + nw1;
                let (dw0, dw1, dh) = if total_natural <= sw {
                    (nw0, nw1, sh)
                } else {
                    let scale = sw as f64 / total_natural as f64;
                    let dh = (sh as f64 * scale).round() as u32;
                    (
                        (nw0 as f64 * scale).round() as u32,
                        (nw1 as f64 * scale).round() as u32,
                        dh,
                    )
                };
                let pair_w = dw0 + GAP + dw1;
                let x0 = ((sw.saturating_sub(pair_w)) / 2) as i32;
                let y0 = ((sh.saturating_sub(dh)) / 2) as i32;
                if flipped {
                    vec![
                        (Rect::new(x0 + dw1 as i32 + GAP as i32, y0, dw0, dh), None),
                        (Rect::new(x0, y0, dw1, dh), None),
                    ]
                } else {
                    vec![
                        (Rect::new(x0, y0, dw0, dh), None),
                        (Rect::new(x0 + dw0 as i32 + GAP as i32, y0, dw1, dh), None),
                    ]
                }
            }

            SlideLayout::SquarePortrait { square_right } => {
                // Square + portrait side by side (same sizing as DualPortrait)
                let nw0 = natural_w_at_h(sizes[0], sh);
                let nw1 = natural_w_at_h(sizes[1], sh);
                let total_natural = nw0 + GAP + nw1;
                let (dw0, dw1, dh) = if total_natural <= sw {
                    (nw0, nw1, sh)
                } else {
                    let scale = sw as f64 / total_natural as f64;
                    let dh = (sh as f64 * scale).round() as u32;
                    (
                        (nw0 as f64 * scale).round() as u32,
                        (nw1 as f64 * scale).round() as u32,
                        dh,
                    )
                };
                let pair_w = dw0 + GAP + dw1;
                let x0 = ((sw.saturating_sub(pair_w)) / 2) as i32;
                let y0 = ((sh.saturating_sub(dh)) / 2) as i32;
                // slot 0 = square, slot 1 = portrait
                if square_right {
                    vec![
                        (Rect::new(x0 + dw1 as i32 + GAP as i32, y0, dw0, dh), None),
                        (Rect::new(x0, y0, dw1, dh), None),
                    ]
                } else {
                    vec![
                        (Rect::new(x0, y0, dw0, dh), None),
                        (Rect::new(x0 + dw0 as i32 + GAP as i32, y0, dw1, dh), None),
                    ]
                }
            }

            SlideLayout::PortraitDualLandscape { portrait_right } => {
                // Slot 0 = portrait, slots 1+2 = two landscapes stacked in the remaining column.
                // All three panels share the same layout height. After determining that height,
                // portrait_w and col_w are always derived from it (not scaled independently),
                // ensuring portrait_w + GAP + col_w == sw at all times.
                const MAX_SCALE: f32 = 1.2;
                // Landscape cells are wider than the image ratio when the layout is scaled
                // down to fit sh (e.g. 9:16 portrait + 16:9 landscapes → ~1.9:1 cells).
                // Common photos (3:2 DSLR, 4:3 phone) need up to ~31% crop to fill those
                // cells. 0.35 covers all typical aspect ratios without going to center-align.
                const MAX_CROP: f32 = 0.35;

                // Use sensible default ratios when sizes are not yet loaded.
                let r_p = {
                    let (pw, ph) = sizes[0].unwrap_or((2, 3)); // typical portrait
                    if ph == 0 {
                        0.667_f64
                    } else {
                        pw as f64 / ph as f64
                    }
                };
                let r1 = {
                    let (w, h) = sizes[1].unwrap_or((3, 2)); // typical landscape
                    if h == 0 {
                        1.5_f64
                    } else {
                        w as f64 / h as f64
                    }
                };
                let r2 = {
                    let (w, h) = sizes[2].unwrap_or((3, 2));
                    if h == 0 {
                        1.5_f64
                    } else {
                        w as f64 / h as f64
                    }
                };

                let sum_inv_r = 1.0 / r1 + 1.0 / r2;
                // Analytically solve for the natural layout height where:
                //   col_w = sw - GAP - total_col_h * r_p
                //   h_top + h_bot + GAP = total_col_h  (landscapes fill column naturally)
                // => total_col_h * (1 + r_p * sum_inv_r) = (sw - GAP) * sum_inv_r + GAP
                let natural_h =
                    ((sw as f64 - GAP as f64) * sum_inv_r + GAP as f64) / (1.0 + r_p * sum_inv_r);

                // Clamp: scale down to sh if too tall; scale up if unused > 25%, with 1.2× cap.
                let target_h = if natural_h > sh as f64 {
                    sh as f64
                } else {
                    let unused = (sh as f64 - natural_h) / sh as f64;
                    if unused > 0.25 {
                        let natural_col_w = sw as f64 - GAP as f64 - natural_h * r_p;
                        let max_s_portrait = MAX_SCALE as f64
                            * sizes[0].map(|s| s.1 as f64).unwrap_or(natural_h)
                            / natural_h;
                        let h_top_n = natural_col_w / r1;
                        let h_bot_n = natural_col_w / r2;
                        let max_s_l1 = MAX_SCALE as f64
                            * sizes[1].map(|s| s.1 as f64).unwrap_or(h_top_n)
                            / h_top_n.max(1.0);
                        let max_s_l2 = MAX_SCALE as f64
                            * sizes[2].map(|s| s.1 as f64).unwrap_or(h_bot_n)
                            / h_bot_n.max(1.0);
                        let max_s = max_s_portrait
                            .min(max_s_l1)
                            .min(max_s_l2)
                            .min(sh as f64 / natural_h);
                        natural_h * max_s.max(1.0)
                    } else {
                        natural_h
                    }
                };

                let total_col_h = target_h.round() as u32;
                // Always derive portrait_w and col_w from total_col_h so their sum = sw - GAP.
                let portrait_w =
                    ((target_h * r_p).round() as i32).clamp(1, sw as i32 - GAP as i32 - 1) as u32;
                let col_w = (sw as i32 - GAP as i32 - portrait_w as i32).max(1) as u32;
                // Row heights: scale natural heights to fill total_col_h - GAP.
                let h_top_n = (col_w as f64 / r1).max(1.0);
                let h_bot_n = (col_w as f64 / r2).max(1.0);
                let available = total_col_h.saturating_sub(GAP) as f64;
                let h_row_scale = available / (h_top_n + h_bot_n);
                let h_top = (h_top_n * h_row_scale).round() as u32;
                let h_bot = total_col_h.saturating_sub(GAP).saturating_sub(h_top);

                let layout_y = ((sh.saturating_sub(total_col_h)) / 2) as i32;
                let by_ = layout_y + h_top as i32 + GAP as i32;

                let (portrait_x, col_x) = if portrait_right {
                    (sw as i32 - portrait_w as i32, 0_i32)
                } else {
                    (0_i32, portrait_w as i32 + GAP as i32)
                };

                // Helper: cover-mode preferred; center-aligned contain as fallback.
                // Centering ensures no directional bias when the image ratio doesn't match the cell.
                let place = |iw: u32,
                             ih: u32,
                             bx: i32,
                             by: i32,
                             bw: u32,
                             bh: u32|
                 -> (Rect, Option<Rect>) {
                    if let Some((dst, src)) =
                        Self::fit_cover(iw, ih, bx, by, bw, bh, MAX_SCALE, MAX_CROP)
                    {
                        return (dst, Some(src));
                    }
                    // Center-aligned contain: equal letterbox on both axes.
                    if iw == 0 || ih == 0 {
                        return (Rect::new(bx, by, bw.max(1), bh.max(1)), None);
                    }
                    let img_r = iw as f64 / ih as f64;
                    let box_r = bw as f64 / bh as f64;
                    let (fw, fh) = if img_r > box_r {
                        let fw = bw;
                        (fw, ((bw as f64 / img_r).round() as u32).max(1))
                    } else {
                        let fh = bh;
                        (((bh as f64 * img_r).round() as u32).max(1), fh)
                    };
                    let x = bx + (bw as i32 - fw as i32) / 2;
                    let y = by + (bh as i32 - fh as i32) / 2;
                    (Rect::new(x, y, fw, fh), None)
                };

                let (portrait_iw, portrait_ih) = sizes[0].unwrap_or((portrait_w, total_col_h));
                let (land1_iw, land1_ih) = sizes[1].unwrap_or((col_w, h_top));
                let (land2_iw, land2_ih) = sizes[2].unwrap_or((col_w, h_bot));

                let portrait_rect = place(
                    portrait_iw,
                    portrait_ih,
                    portrait_x,
                    layout_y,
                    portrait_w,
                    total_col_h,
                );
                let land1 = place(land1_iw, land1_ih, col_x, layout_y, col_w, h_top);
                let land2 = place(land2_iw, land2_ih, col_x, by_, col_w, h_bot);

                vec![portrait_rect, land1, land2]
            }

            SlideLayout::QuadLandscape { flipped } => {
                // 2×2 grid with natural cell sizes derived from image aspect ratios.
                // Fills full canvas width; row heights are computed from those column widths.
                const MAX_SCALE: f32 = 1.2;
                // Column widths are derived from image ratios so cells closely match images.
                // Still allow up to 25% crop for the scale-down case and mixed-ratio images.
                const MAX_CROP: f32 = 0.25;

                // Assign slots: non-flipped → TL=0, BL=1, TR=2, BR=3
                //               flipped     → TL=2, BL=3, TR=0, BR=1
                let (tl, bl, tr, br) = if flipped { (2, 3, 0, 1) } else { (0, 1, 2, 3) };

                let ratio = |i: usize| -> f64 {
                    let (w, h) = sizes[i].unwrap_or((1, 1));
                    if h == 0 {
                        1.0
                    } else {
                        w as f64 / h as f64
                    }
                };
                let r_tl = ratio(tl);
                let r_bl = ratio(bl);
                let r_tr = ratio(tr);
                let r_br = ratio(br);

                // Natural column widths proportional to geometric mean of each column's ratios.
                let r_left = (r_tl * r_bl).sqrt();
                let r_right = (r_tr * r_br).sqrt();
                let w_left =
                    ((sw as f64 - GAP as f64) * r_left / (r_left + r_right)).round() as u32;
                let w_right = sw.saturating_sub(GAP).saturating_sub(w_left);

                // Natural row heights: average of each image's natural height at its column width.
                let h_top_f = (w_left as f64 / r_tl + w_right as f64 / r_tr) / 2.0;
                let h_bot_f = (w_left as f64 / r_bl + w_right as f64 / r_br) / 2.0;
                let total_h_f = h_top_f + GAP as f64 + h_bot_f;

                let v_scale = if total_h_f > sh as f64 {
                    // Scale down to fit canvas height.
                    (sh as f64 - GAP as f64) / (h_top_f + h_bot_f)
                } else {
                    let unused = (sh as f64 - total_h_f) / sh as f64;
                    if unused > 0.25 {
                        // Scale up, capped at 1.2× for any image.
                        let cap = |h_natural: f64, slot: usize| -> f64 {
                            let ih = sizes[slot].map(|s| s.1 as f64).unwrap_or(h_natural);
                            if ih == 0.0 {
                                f64::MAX
                            } else {
                                MAX_SCALE as f64 * ih / h_natural
                            }
                        };
                        let max_s = cap(h_top_f, tl)
                            .min(cap(h_top_f, tr))
                            .min(cap(h_bot_f, bl))
                            .min(cap(h_bot_f, br))
                            .min((sh as f64 - GAP as f64) / (h_top_f + h_bot_f));
                        max_s.max(1.0)
                    } else {
                        1.0
                    }
                };

                let h_top = (h_top_f * v_scale).round() as u32;
                let total_h = (h_top_f * v_scale + GAP as f64 + h_bot_f * v_scale).round() as u32;
                let h_bot = total_h.saturating_sub(GAP).saturating_sub(h_top);

                let layout_y = ((sh.saturating_sub(total_h)) / 2) as i32;
                let rx = w_left as i32 + GAP as i32;
                let by_ = layout_y + h_top as i32 + GAP as i32;

                // Helper: cover-mode preferred; center-aligned contain as fallback.
                let place_cell =
                    |slot: usize, bx: i32, by: i32, bw: u32, bh: u32| -> (Rect, Option<Rect>) {
                        let (iw, ih) = sizes[slot].unwrap_or((bw, bh));
                        if let Some((dst, src)) =
                            Self::fit_cover(iw, ih, bx, by, bw, bh, MAX_SCALE, MAX_CROP)
                        {
                            return (dst, Some(src));
                        }
                        if iw == 0 || ih == 0 {
                            return (Rect::new(bx, by, bw.max(1), bh.max(1)), None);
                        }
                        let img_r = iw as f64 / ih as f64;
                        let box_r = bw as f64 / bh as f64;
                        let (fw, fh) = if img_r > box_r {
                            let fw = bw;
                            (fw, ((bw as f64 / img_r).round() as u32).max(1))
                        } else {
                            let fh = bh;
                            (((bh as f64 * img_r).round() as u32).max(1), fh)
                        };
                        let x = bx + (bw as i32 - fw as i32) / 2;
                        let y = by + (bh as i32 - fh as i32) / 2;
                        (Rect::new(x, y, fw, fh), None)
                    };

                let r_tl_rect = place_cell(tl, 0, layout_y, w_left, h_top);
                let r_bl_rect = place_cell(bl, 0, by_, w_left, h_bot);
                let r_tr_rect = place_cell(tr, rx, layout_y, w_right, h_top);
                let r_br_rect = place_cell(br, rx, by_, w_right, h_bot);

                // Return in slot order (0,1,2,3)
                let mut result = [(Rect::new(0, 0, 1, 1), None); 4];
                result[tl] = r_tl_rect;
                result[bl] = r_bl_rect;
                result[tr] = r_tr_rect;
                result[br] = r_br_rect;
                vec![result[0], result[1], result[2], result[3]]
            }
        }
    }

    /// Render all panels for the current layout — backgrounds, images, and gap lines.
    fn render_layout_panels<'a>(
        &mut self,
        _tc: &'a TextureCreator<WindowContext>,
        panels: &mut [&mut MediaTextures<'a>],
        layout: SlideLayout,
        alpha: u8,
    ) -> Result<()> {
        const GAP: u32 = 8;
        const BG_BLEND_HALF: i32 = 150; // half-width of the background blend zone
        let sw = self.screen_width;
        let sh = self.screen_height;

        let mut sizes: [Option<(u32, u32)>; 4] = [None; 4];
        for (i, p) in panels.iter().enumerate() {
            sizes[i] = p.display_size;
        }

        let rects = Self::compute_panel_rects(layout, sw, sh, &sizes);
        let n = rects.len();

        // Record rects for info overlay
        self.last_image_rects = [None; 4];
        for (i, (r, _)) in rects.iter().enumerate() {
            if i < 4 {
                self.last_image_rects[i] = Some(*r);
            }
        }

        if n == 1 {
            // Single image — use the standard single-panel background render
            if self.blur_background {
                if let Some(ref mut blur) = panels[0].blur {
                    blur.set_alpha_mod(alpha);
                    self.canvas
                        .copy(blur, None, None)
                        .map_err(|e| anyhow::anyhow!("blur: {}", e))?;
                }
            }
            if let Some(ref mut display) = panels[0].display {
                display.set_alpha_mod(alpha);
                self.canvas
                    .copy(display, None, rects[0].0)
                    .map_err(|e| anyhow::anyhow!("display: {}", e))?;
            }
            return Ok(());
        }

        // Multi-panel: render backgrounds with wide blending, then images, then gap lines

        // Step 1: For each panel, draw its blur texture on its half of the screen,
        //         then blend neighbours across a wide zone centered on the gap.
        if self.blur_background {
            // Collect background dividing lines (x or y boundaries between panels).
            // We find vertical gaps (between left and right columns) and horizontal gaps
            // (between top and bottom rows) and do a wide gradient blend across each.
            //
            // Simple approach: draw each blur full-screen at full alpha first, then
            // overdraw with adjacent panels' blurs, fading in/out across blend_half px
            // centered on the gap center.

            // Draw panel 0's blur as base
            if let Some(ref mut blur) = panels[0].blur {
                blur.set_alpha_mod(alpha);
                self.canvas
                    .copy(blur, None, None)
                    .map_err(|e| anyhow::anyhow!("bg blur 0: {}", e))?;
            }

            // For each subsequent panel, overdraw its blur with wide gradient blending
            // at each spatial seam. Seams are detected by comparing against ALL already-drawn
            // panels (not just the previous index), so diagonal neighbours (QuadLandscape BR)
            // correctly receive both vertical and horizontal gradients.
            //
            // seam direction encoding: positive = this panel is to the RIGHT of / BELOW the seam
            //                          negative = this panel is to the LEFT of / ABOVE the seam
            for i in 1..n {
                let p = &mut panels[i];
                if p.blur.is_none() {
                    continue;
                }

                let this_r = rects[i].0;

                // Find seams against any already-drawn panel (j < i).
                // Track both the seam position and whether this panel is to the right/below it.
                let mut seam_x: Option<(i32, bool)> = None; // (seam_x_coord, this_is_right_of_seam)
                let mut seam_y: Option<(i32, bool)> = None; // (seam_y_coord, this_is_below_seam)
                for other in rects.iter().take(i) {
                    let other = other.0;
                    // Panels are in different columns if their x-centres differ more than a gap width
                    if (other.x() - this_r.x()).abs() > GAP as i32 {
                        if other.x() < this_r.x() {
                            // other is to the left → seam at this panel's left edge, this is right-of
                            seam_x = Some((this_r.x(), true));
                        } else {
                            // other is to the right → seam at other's left edge, this is left-of
                            seam_x = Some((other.x(), false));
                        }
                    }
                    // Panels are in different rows
                    if (other.y() - this_r.y()).abs() > GAP as i32 {
                        if other.y() < this_r.y() {
                            seam_y = Some((this_r.y(), true));
                        } else {
                            seam_y = Some((other.y(), false));
                        }
                    }
                }

                let blur = p.blur.as_mut().unwrap();

                // Helper: compute the alpha for a column x given a vertical seam.
                // this_is_right_of_seam=true  → panel lives to the right: alpha ramps 0→full rightward
                // this_is_right_of_seam=false → panel lives to the left:  alpha ramps full→0 rightward
                let v_alpha = |x: i32, seam: i32, this_is_right: bool| -> u8 {
                    let bs = (seam - BG_BLEND_HALF).max(0);
                    let be = (seam + BG_BLEND_HALF).min(sw as i32);
                    if be == bs {
                        return if this_is_right { alpha } else { 0 };
                    }
                    let t = ((x - bs) as f32 / (be - bs) as f32).clamp(0.0, 1.0);
                    let t = if this_is_right { t } else { 1.0 - t };
                    (t * alpha as f32).round() as u8
                };
                // Helper: compute alpha for a row y given a horizontal seam.
                let h_alpha = |y: i32, seam: i32, this_is_below: bool| -> u8 {
                    let bs = (seam - BG_BLEND_HALF).max(0);
                    let be = (seam + BG_BLEND_HALF).min(sh as i32);
                    if be == bs {
                        return if this_is_below { alpha } else { 0 };
                    }
                    let t = ((y - bs) as f32 / (be - bs) as f32).clamp(0.0, 1.0);
                    let t = if this_is_below { t } else { 1.0 - t };
                    (t * alpha as f32).round() as u8
                };

                match (seam_x, seam_y) {
                    (None, None) => {
                        // No spatial seam found – full overdraw fallback
                        blur.set_alpha_mod(alpha);
                        self.canvas
                            .copy(blur, None, None)
                            .map_err(|e| anyhow::anyhow!("bg full: {}", e))?;
                    }
                    (Some((vx, vright)), None) => {
                        // Only vertical seam — draw column by column across the blend zone,
                        // then fill the "own side" solid region.
                        let blend_start = (vx - BG_BLEND_HALF).max(0);
                        let blend_end = (vx + BG_BLEND_HALF).min(sw as i32);
                        // Solid region on the "own" side
                        let (solid_x, solid_w) = if vright {
                            (blend_end, sw as i32 - blend_end)
                        } else {
                            (0, blend_start)
                        };
                        if solid_w > 0 {
                            self.canvas
                                .set_clip_rect(Rect::new(solid_x, 0, solid_w as u32, sh));
                            blur.set_alpha_mod(alpha);
                            self.canvas
                                .copy(blur, None, None)
                                .map_err(|e| anyhow::anyhow!("bg v solid: {}", e))?;
                            self.canvas.set_clip_rect(None::<Rect>);
                        }
                        // Gradient blend zone
                        for x in blend_start..blend_end {
                            let a = v_alpha(x, vx, vright);
                            if a == 0 {
                                continue;
                            }
                            let src_x = ((x as f64 / sw as f64) * (sw as f64 - 1.0)).round() as i32;
                            blur.set_alpha_mod(a);
                            self.canvas
                                .copy(
                                    blur,
                                    Rect::new(src_x.max(0), 0, 1, sh),
                                    Rect::new(x, 0, 1, sh),
                                )
                                .map_err(|e| anyhow::anyhow!("bg blend col: {}", e))?;
                        }
                    }
                    (None, Some((hy, hbelow))) => {
                        // Only horizontal seam
                        let blend_start = (hy - BG_BLEND_HALF).max(0);
                        let blend_end = (hy + BG_BLEND_HALF).min(sh as i32);
                        let (solid_y, solid_h) = if hbelow {
                            (blend_end, sh as i32 - blend_end)
                        } else {
                            (0, blend_start)
                        };
                        if solid_h > 0 {
                            self.canvas
                                .set_clip_rect(Rect::new(0, solid_y, sw, solid_h as u32));
                            blur.set_alpha_mod(alpha);
                            self.canvas
                                .copy(blur, None, None)
                                .map_err(|e| anyhow::anyhow!("bg h solid: {}", e))?;
                            self.canvas.set_clip_rect(None::<Rect>);
                        }
                        for y in blend_start..blend_end {
                            let a = h_alpha(y, hy, hbelow);
                            if a == 0 {
                                continue;
                            }
                            let src_y = ((y as f64 / sh as f64) * (sh as f64 - 1.0)).round() as i32;
                            blur.set_alpha_mod(a);
                            self.canvas
                                .copy(
                                    blur,
                                    Rect::new(0, src_y.max(0), sw, 1),
                                    Rect::new(0, y, sw, 1),
                                )
                                .map_err(|e| anyhow::anyhow!("bg blend row: {}", e))?;
                        }
                    }
                    (Some((vx, vright)), Some((hy, hbelow))) => {
                        // Both seams (e.g. BR panel in QuadLandscape, or BL in flipped layout).
                        // Combine vertical and horizontal gradients: alpha = v_alpha * h_alpha / 255.
                        // Solid quadrant (own corner)
                        let (solid_x, solid_w) = if vright {
                            (vx + BG_BLEND_HALF, sw as i32 - vx - BG_BLEND_HALF)
                        } else {
                            (0, vx - BG_BLEND_HALF)
                        };
                        let (solid_y, solid_h) = if hbelow {
                            (hy + BG_BLEND_HALF, sh as i32 - hy - BG_BLEND_HALF)
                        } else {
                            (0, hy - BG_BLEND_HALF)
                        };
                        let solid_x = solid_x.max(0);
                        let solid_w = solid_w.max(0);
                        let solid_y = solid_y.max(0);
                        let solid_h = solid_h.max(0);
                        if solid_w > 0 && solid_h > 0 {
                            self.canvas.set_clip_rect(Rect::new(
                                solid_x,
                                solid_y,
                                solid_w as u32,
                                solid_h as u32,
                            ));
                            blur.set_alpha_mod(alpha);
                            self.canvas
                                .copy(blur, None, None)
                                .map_err(|e| anyhow::anyhow!("bg 2d solid: {}", e))?;
                            self.canvas.set_clip_rect(None::<Rect>);
                        }
                        // Per-pixel blend across seam regions (column-by-column for efficiency)
                        let vbs = (vx - BG_BLEND_HALF).max(0);
                        let vbe = (vx + BG_BLEND_HALF).min(sw as i32);
                        let hbs = (hy - BG_BLEND_HALF).max(0);
                        let hbe = (hy + BG_BLEND_HALF).min(sh as i32);
                        // For rows in the h-blend zone: draw each column with combined alpha
                        for y in hbs..hbe {
                            let ha = h_alpha(y, hy, hbelow);
                            if ha == 0 {
                                continue;
                            }
                            let src_y = ((y as f64 / sh as f64) * (sh as f64 - 1.0)).round() as i32;
                            // Solid side of v-seam for this row
                            if solid_w > 0 {
                                self.canvas
                                    .set_clip_rect(Rect::new(solid_x, y, solid_w as u32, 1));
                                blur.set_alpha_mod(ha);
                                self.canvas
                                    .copy(
                                        blur,
                                        Rect::new(0, src_y.max(0), sw, 1),
                                        Rect::new(0, y, sw, 1),
                                    )
                                    .map_err(|e| anyhow::anyhow!("bg 2d h+vsolid: {}", e))?;
                                self.canvas.set_clip_rect(None::<Rect>);
                            }
                            // V-blend zone of this row
                            for x in vbs..vbe {
                                let va = v_alpha(x, vx, vright);
                                let combined = ((ha as u16 * va as u16) / 255) as u8;
                                if combined == 0 {
                                    continue;
                                }
                                let src_x =
                                    ((x as f64 / sw as f64) * (sw as f64 - 1.0)).round() as i32;
                                blur.set_alpha_mod(combined);
                                self.canvas
                                    .copy(
                                        blur,
                                        Rect::new(src_x.max(0), src_y.max(0), 1, 1),
                                        Rect::new(x, y, 1, 1),
                                    )
                                    .map_err(|e| anyhow::anyhow!("bg 2d pixel: {}", e))?;
                            }
                        }
                        // For rows outside h-blend but on the own side of h-seam: vertical gradient only
                        for x in vbs..vbe {
                            let va = v_alpha(x, vx, vright);
                            if va == 0 {
                                continue;
                            }
                            let src_x = ((x as f64 / sw as f64) * (sw as f64 - 1.0)).round() as i32;
                            // Above h-blend zone
                            let above_end = hbs.min(sh as i32);
                            let below_start = hbe.max(0);
                            if hbelow && above_end > 0 {
                                // rows 0..hbs are in the "other side" of h-seam — this panel has 0 h-alpha there
                                // nothing to draw
                            } else if !hbelow && below_start < sh as i32 {
                                // rows hbe..sh are in the "other side" — nothing
                            }
                            // Own side of h-seam
                            let (own_y, own_h) = if hbelow {
                                (hbe, sh as i32 - hbe)
                            } else {
                                (0, hbs)
                            };
                            let own_y = own_y.max(0);
                            let own_h = own_h.max(0);
                            if own_h > 0 {
                                blur.set_alpha_mod(va);
                                self.canvas
                                    .copy(
                                        blur,
                                        Rect::new(src_x.max(0), 0, 1, sh),
                                        Rect::new(x, own_y, 1, own_h as u32),
                                    )
                                    .map_err(|e| anyhow::anyhow!("bg 2d vcol: {}", e))?;
                            }
                        }
                    }
                }
                blur.set_alpha_mod(alpha);
            }
        }

        // Step 2: Render each image clipped to its rect
        for (i, (dst, src)) in rects.iter().enumerate() {
            if let Some(ref mut display) = panels[i].display {
                self.canvas.set_clip_rect(*dst);
                display.set_alpha_mod(alpha);
                self.canvas
                    .copy(display, *src, *dst)
                    .map_err(|e| anyhow::anyhow!("img {}: {}", i, e))?;
            }
        }
        self.canvas.set_clip_rect(None::<Rect>);

        // Step 3: Draw 8px near-black gap lines between adjacent image rects.
        // Collect vertical (x) and horizontal (y) seam positions so we can fill
        // intersection squares afterward (avoids the open corner at 3-/4-way junctions).
        self.canvas.set_draw_color(Color::RGB(17, 17, 17));
        let mut vseams: Vec<i32> = Vec::new(); // x-coords of vertical gap left edges
        let mut hseams: Vec<i32> = Vec::new(); // y-coords of horizontal gap top edges
        for i in 0..n {
            for j in (i + 1)..n {
                let a = rects[i].0;
                let b = rects[j].0;
                // Vertical gap (a is left of b)
                if (a.right() + GAP as i32) <= b.x() + 2 {
                    let gx = a.right();
                    let top = a.y().max(b.y());
                    let bot = (a.y() + a.height() as i32).min(b.y() + b.height() as i32);
                    if bot > top {
                        self.canvas
                            .fill_rect(Rect::new(gx, top, GAP, (bot - top) as u32))
                            .map_err(|e| anyhow::anyhow!("gap v: {}", e))?;
                        if !vseams.contains(&gx) {
                            vseams.push(gx);
                        }
                    }
                }
                // Vertical gap (b is left of a)
                if (b.right() + GAP as i32) <= a.x() + 2 {
                    let gx = b.right();
                    let top = a.y().max(b.y());
                    let bot = (a.y() + a.height() as i32).min(b.y() + b.height() as i32);
                    if bot > top {
                        self.canvas
                            .fill_rect(Rect::new(gx, top, GAP, (bot - top) as u32))
                            .map_err(|e| anyhow::anyhow!("gap v2: {}", e))?;
                        if !vseams.contains(&gx) {
                            vseams.push(gx);
                        }
                    }
                }
                // Horizontal gap (a is above b)
                if (a.y() + a.height() as i32 + GAP as i32) <= b.y() + 2 {
                    let gy = a.y() + a.height() as i32;
                    let left = a.x().max(b.x());
                    let right = (a.x() + a.width() as i32).min(b.x() + b.width() as i32);
                    if right > left {
                        self.canvas
                            .fill_rect(Rect::new(left, gy, (right - left) as u32, GAP))
                            .map_err(|e| anyhow::anyhow!("gap h: {}", e))?;
                        if !hseams.contains(&gy) {
                            hseams.push(gy);
                        }
                    }
                }
                // Horizontal gap (b is above a)
                if (b.y() + b.height() as i32 + GAP as i32) <= a.y() + 2 {
                    let gy = b.y() + b.height() as i32;
                    let left = a.x().max(b.x());
                    let right = (a.x() + a.width() as i32).min(b.x() + b.width() as i32);
                    if right > left {
                        self.canvas
                            .fill_rect(Rect::new(left, gy, (right - left) as u32, GAP))
                            .map_err(|e| anyhow::anyhow!("gap h2: {}", e))?;
                        if !hseams.contains(&gy) {
                            hseams.push(gy);
                        }
                    }
                }
            }
        }
        // Fill the GAP×GAP corner squares at every vertical+horizontal seam intersection.
        for &gx in &vseams {
            for &gy in &hseams {
                self.canvas
                    .fill_rect(Rect::new(gx, gy, GAP, GAP))
                    .map_err(|e| anyhow::anyhow!("gap corner: {}", e))?;
            }
        }

        Ok(())
    }

    /// Render all panels (with transition support) for the current layout.
    pub fn render_layout<'a>(
        &mut self,
        tc: &'a TextureCreator<WindowContext>,
        panels: &mut [&mut MediaTextures<'a>],
        next_panels: Option<&mut [&mut MediaTextures<'a>]>,
    ) -> Result<()> {
        self.canvas.set_draw_color(Color::RGB(0, 0, 0));
        self.canvas.clear();

        let alpha = match (self.transition_type, self.transition_state) {
            (Transition::Cut, _) | (_, TransitionState::Idle) => 255u8,
            (_, TransitionState::TransitioningOut { progress }) => ((1.0 - progress) * 255.0) as u8,
            (_, TransitionState::TransitioningIn { progress }) => (progress * 255.0) as u8,
        };

        // The outgoing panels always use current_layout (unchanged until the
        // swap point below flips it). The incoming panels use whatever layout
        // was picked for the next slide, which may have a different shape
        // (e.g. Single -> DualPortrait) — using the wrong one here is what
        // caused stale/mismatched panels to flash during a transition.
        let incoming_layout = self.incoming_layout.unwrap_or(self.current_layout);

        if self.transition_type == Transition::Crossfade {
            if let TransitionState::TransitioningOut { progress } = self.transition_state {
                let next_alpha = (progress * 255.0) as u8;
                if let Some(np) = next_panels {
                    self.render_layout_panels(tc, np, incoming_layout, next_alpha)?;
                }
            }
        }

        self.render_layout_panels(tc, panels, self.current_layout, alpha)?;

        if self.show_clock {
            self.render_clock(tc)?;
        }

        Ok(())
    }

    /// Start a transition to the next image, which may use a different
    /// layout than the one currently on screen. `current_layout` keeps
    /// describing the outgoing panels until `update_transition` flips it at
    /// the swap point.
    pub fn start_transition(&mut self, incoming_layout: SlideLayout) {
        self.transition_state = TransitionState::TransitioningOut { progress: 0.0 };
        self.transition_start = Some(Instant::now());
        self.incoming_layout = Some(incoming_layout);
    }

    /// Check if a transition is currently in progress.
    pub fn is_transitioning(&self) -> bool {
        self.transition_state != TransitionState::Idle
    }

    /// Layout for the incoming slide during a transition, if one is pending.
    pub fn incoming_layout(&self) -> Option<SlideLayout> {
        self.incoming_layout
    }

    /// Update transition state based on elapsed time.
    pub fn update_transition(&mut self) -> bool {
        let Some(start) = self.transition_start else {
            return false;
        };

        let elapsed = start.elapsed().as_millis() as f32;
        let is_crossfade = self.transition_type == Transition::Crossfade;
        // Crossfade uses the full duration as one continuous blend; Fade splits into two halves.
        let out_duration = if is_crossfade {
            self.transition_duration_ms as f32
        } else {
            self.transition_duration_ms as f32 / 2.0
        };

        match self.transition_state {
            TransitionState::Idle => false,
            TransitionState::TransitioningOut { .. } => {
                let progress = (elapsed / out_duration).min(1.0);
                if progress >= 1.0 {
                    // Swap point: flip current_layout to the incoming slide's
                    // layout in lockstep with the texture swap the caller
                    // performs on this same `true` return, so the two never
                    // observe different layouts on the same frame.
                    if let Some(incoming) = self.incoming_layout.take() {
                        self.current_layout = incoming;
                    }
                    if is_crossfade {
                        // Crossfade is done — swap and go idle immediately.
                        self.transition_state = TransitionState::Idle;
                        self.transition_start = None;
                    } else {
                        self.transition_state = TransitionState::TransitioningIn { progress: 0.0 };
                    }
                    true // Signal to swap textures
                } else {
                    self.transition_state = TransitionState::TransitioningOut { progress };
                    false
                }
            }
            TransitionState::TransitioningIn { .. } => {
                let half = self.transition_duration_ms as f32 / 2.0;
                let progress = ((elapsed - half) / half).min(1.0);
                if progress >= 1.0 {
                    self.transition_state = TransitionState::Idle;
                    self.transition_start = None;
                } else {
                    self.transition_state = TransitionState::TransitioningIn { progress };
                }
                false
            }
        }
    }

    /// Render the current frame with optional transition effects.
    ///
    /// Takes mutable references to properly set alpha modulation on textures
    /// without using unsafe code.
    pub fn render<'a>(
        &mut self,
        texture_creator: &'a sdl2::render::TextureCreator<sdl2::video::WindowContext>,
        current: &mut MediaTextures<'a>,
        mut next: Option<&mut MediaTextures<'a>>,
    ) -> Result<()> {
        // Clear to black
        self.canvas
            .set_draw_color(sdl2::pixels::Color::RGB(0, 0, 0));
        self.canvas.clear();

        let alpha = match (self.transition_type, self.transition_state) {
            (Transition::Cut, _) | (_, TransitionState::Idle) => 255u8,
            (_, TransitionState::TransitioningOut { progress }) => ((1.0 - progress) * 255.0) as u8,
            (_, TransitionState::TransitioningIn { progress }) => (progress * 255.0) as u8,
        };

        // For crossfade, we need to render next image underneath first
        if self.transition_type == Transition::Crossfade {
            if let TransitionState::TransitioningOut { progress } = self.transition_state {
                // Render next image underneath with increasing alpha
                if let Some(ref mut next_tex) = next {
                    self.render_media_textures(
                        texture_creator,
                        next_tex,
                        (progress * 255.0) as u8,
                    )?;
                }
            }
        }

        // Render current/main textures
        self.render_media_textures(texture_creator, current, alpha)?;

        if self.show_clock {
            self.render_clock(texture_creator)?;
        }

        Ok(())
    }

    /// Present the rendered frame to the screen.
    /// Must be called after all overlays have been drawn.
    pub fn present(&mut self) {
        self.canvas.present();
    }

    fn render_clock(&mut self, texture_creator: &TextureCreator<WindowContext>) -> Result<()> {
        let Some(font) = &self.font_clock else {
            return Ok(());
        };
        let clock_text = Self::format_clock_time();
        let surface = font
            .render(&clock_text)
            .blended(Color::RGBA(255, 255, 255, 200))
            .map_err(|e| anyhow::anyhow!("Failed to render clock: {}", e))?;
        let texture = texture_creator
            .create_texture_from_surface(&surface)
            .map_err(|e| anyhow::anyhow!("Failed to create clock texture: {}", e))?;
        let query = texture.query();

        let base_margin = (self.screen_width.min(self.screen_height) as f32 * 0.035).round() as i32;
        // The raw corner margin sat the clock too close to the edge in practice —
        // this is the horizontal inset admins converged on via clockOffsetX before
        // it became the default resting position (clockOffsetX now adjusts from here).
        let default_x_inset = 101;
        let x = self.screen_width as i32
            - query.width as i32
            - base_margin
            - default_x_inset
            - self.clock_offset_x;
        let y = self.screen_height as i32 - query.height as i32 - base_margin - self.clock_offset_y;
        let dest = Rect::new(x, y, query.width, query.height);

        // Warm dark brown shadow — softer and less harsh than pure black
        let shadow_surface = font
            .render(&clock_text)
            .blended(Color::RGBA(28, 14, 6, 200))
            .map_err(|e| anyhow::anyhow!("Failed to render clock shadow: {}", e))?;
        let offsets: &[(i32, i32, u8)] = &[
            (-2, 0, 60),
            (2, 0, 60),
            (0, -2, 60),
            (0, 2, 60),
            (-2, -2, 35),
            (2, -2, 35),
            (-2, 2, 35),
            (2, 2, 35),
        ];
        for &(dx, dy, a) in offsets {
            let mut shadow = texture_creator
                .create_texture_from_surface(&shadow_surface)
                .map_err(|e| anyhow::anyhow!("Failed to create clock shadow texture: {}", e))?;
            shadow.set_alpha_mod(a);
            self.canvas
                .copy(
                    &shadow,
                    None,
                    Rect::new(x + dx, y + dy, query.width, query.height),
                )
                .map_err(|e| anyhow::anyhow!("Failed to copy clock shadow: {}", e))?;
        }
        self.canvas
            .copy(&texture, None, dest)
            .map_err(|e| anyhow::anyhow!("Failed to copy clock: {}", e))?;

        Ok(())
    }

    fn format_clock_time() -> String {
        #[cfg(unix)]
        {
            let mut now: libc::time_t = 0;
            let mut local: libc::tm = unsafe { std::mem::zeroed() };
            unsafe {
                libc::time(&mut now);
                if libc::localtime_r(&now, &mut local).is_null() {
                    return "12:00".to_string();
                }
            }
            let hour_24 = local.tm_hour;
            let hour_12 = match hour_24 % 12 {
                0 => 12,
                hour => hour,
            };
            format!("{:02}:{:02}", hour_12, local.tm_min)
        }

        #[cfg(not(unix))]
        {
            "12:00".to_string()
        }
    }

    /// Render media textures (blur background + aspect-fit display).
    /// Blur texture is pre-generated by `generate_blur_texture`; this just blits it.
    ///
    /// The blur is drawn only in the letterbox area *outside* the display's
    /// aspect-fit rect, never underneath it. Video's blur is generated once
    /// from the poster frame and never updated again during playback, so if
    /// it were drawn full-screen behind the live video, alpha-blending both
    /// layers independently at the same fading alpha would let that stale
    /// poster leak through: `fg*a + blur*a*(1-a)` isn't zero for 0<a<1 even
    /// when the live frame (fg) is pure black, which happens right as a clip
    /// with its own fade-to-black ending hits our transition-out. Excluding
    /// the overlap means there's nothing behind the foreground to leak.
    fn render_media_textures<'a>(
        &mut self,
        _texture_creator: &'a sdl2::render::TextureCreator<sdl2::video::WindowContext>,
        textures: &mut MediaTextures<'a>,
        alpha: u8,
    ) -> Result<()> {
        let dest_rect = textures
            .display_size
            .map(|(w, h)| self.calculate_aspect_fit(w, h));

        if self.blur_background {
            if let Some(ref mut blur) = textures.blur {
                blur.set_alpha_mod(alpha);
                match dest_rect {
                    Some(r) => self.copy_excluding(blur, r)?,
                    None => {
                        self.canvas
                            .copy(blur, None, None)
                            .map_err(|e| anyhow::anyhow!("Failed to render blur: {}", e))?;
                    }
                }
            } else if let Some(ref mut display) = textures.display {
                // Fallback: dim the display image as the background
                if let Some(r) = dest_rect {
                    display.set_color_mod(80, 80, 80);
                    display.set_alpha_mod(alpha);
                    let _ = self.copy_excluding(display, r);
                    display.set_color_mod(255, 255, 255);
                }
            }
        }

        // Render main display image with aspect-fit
        if let Some(ref mut display) = textures.display {
            if let Some(r) = dest_rect {
                self.last_image_rects = [Some(r), None, None, None];
                display.set_alpha_mod(alpha);
                self.canvas
                    .copy(display, None, r)
                    .map_err(|e| anyhow::anyhow!("Failed to render display: {}", e))?;
            }
        }

        Ok(())
    }

    /// Draw `tex` stretched to fill the full screen, but skip the `exclude`
    /// region. Splits the screen into up to 4 letterbox bands around
    /// `exclude` and copies the matching source sub-rect into each, so the
    /// result is pixel-identical to a full-screen draw with `exclude` left
    /// untouched.
    fn copy_excluding(&mut self, tex: &mut Texture, exclude: Rect) -> Result<()> {
        let query = tex.query();
        let (tw, th) = (query.width as f64, query.height as f64);
        let (sw, sh) = (self.screen_width as i32, self.screen_height as i32);
        let scale_x = tw / sw as f64;
        let scale_y = th / sh as f64;

        let src_for = |dst: Rect| -> Rect {
            Rect::new(
                (dst.x() as f64 * scale_x).round() as i32,
                (dst.y() as f64 * scale_y).round() as i32,
                ((dst.width() as f64 * scale_x).round() as u32).max(1),
                ((dst.height() as f64 * scale_y).round() as u32).max(1),
            )
        };

        let ex = exclude.x().clamp(0, sw);
        let ey = exclude.y().clamp(0, sh);
        let ew = exclude.width() as i32;
        let eh = exclude.height() as i32;

        let mut bands: Vec<Rect> = Vec::with_capacity(4);
        if ey > 0 {
            bands.push(Rect::new(0, 0, sw as u32, ey as u32)); // top
        }
        if ey + eh < sh {
            bands.push(Rect::new(0, ey + eh, sw as u32, (sh - ey - eh) as u32));
            // bottom
        }
        if ex > 0 {
            bands.push(Rect::new(0, ey, ex as u32, eh.max(0) as u32)); // left
        }
        if ex + ew < sw {
            bands.push(Rect::new(
                ex + ew,
                ey,
                (sw - ex - ew) as u32,
                eh.max(0) as u32,
            )); // right
        }

        for band in bands {
            if band.width() == 0 || band.height() == 0 {
                continue;
            }
            self.canvas
                .copy(tex, Some(src_for(band)), Some(band))
                .map_err(|e| anyhow::anyhow!("Failed to render background band: {}", e))?;
        }

        Ok(())
    }

    /// Process SDL events with extended action support.
    pub fn process_events_extended(&mut self) -> UserAction {
        for event in self.event_pump.poll_iter() {
            match event {
                Event::Quit { .. } => return UserAction::Quit,
                Event::KeyDown {
                    keycode: Some(key), ..
                } => {
                    match key {
                        // Quit
                        Keycode::Escape | Keycode::Q => return UserAction::Quit,
                        // Pause/Resume
                        Keycode::Space | Keycode::Return | Keycode::P => {
                            return UserAction::TogglePause
                        }
                        // Navigation
                        Keycode::Right | Keycode::Down | Keycode::N | Keycode::PageDown => {
                            return UserAction::Next
                        }
                        Keycode::Left | Keycode::Up | Keycode::B | Keycode::PageUp => {
                            return UserAction::Previous
                        }
                        // Refresh
                        Keycode::R | Keycode::F5 => return UserAction::Refresh,
                        // Toggle overlay
                        Keycode::I | Keycode::Tab | Keycode::O => return UserAction::ToggleOverlay,
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        UserAction::None
    }

    /// Sleep for a short duration to limit frame rate.
    pub fn frame_delay(&self) {
        std::thread::sleep(Duration::from_millis(16)); // ~60 FPS
    }

    /// Render the overlay with status information.
    pub fn render_overlay(&mut self, info: &OverlayInfo) -> Result<()> {
        // Semi-transparent background bar at top
        let bar_height = 60u32;
        self.canvas.set_draw_color(Color::RGBA(0, 0, 0, 180));
        self.canvas
            .fill_rect(Rect::new(0, 0, self.screen_width, bar_height))
            .map_err(|e| anyhow::anyhow!("Failed to draw overlay bg: {}", e))?;

        // Connection status indicator (circle)
        let indicator_x = 20i32;
        let indicator_y = (bar_height / 2) as i32;
        let indicator_color = if info.is_offline {
            Color::RGB(255, 100, 100) // Red for offline
        } else if info.is_connected {
            Color::RGB(100, 255, 100) // Green for connected
        } else {
            Color::RGB(255, 200, 100) // Orange for connecting
        };
        self.draw_filled_circle(indicator_x, indicator_y, 8, indicator_color)?;

        // Render text info using TTF if font is available
        if let Some(font) = &self.font_overlay {
            let texture_creator = self.canvas.texture_creator();

            // Media info text
            let status_text = if info.is_paused {
                if let Some(secs) = info.pause_secs_remaining {
                    format!(" [PAUSED {}:{:02}]", secs / 60, secs % 60)
                } else {
                    " [PAUSED]".to_string()
                }
            } else {
                String::new()
            };
            let media_text = format!(
                "{}/{} - {}{}",
                info.current_index,
                info.total_count,
                if info.media_title.len() > 30 {
                    format!("{}...", &info.media_title[..27])
                } else {
                    info.media_title.clone()
                },
                status_text
            );
            Self::render_text(
                &mut self.canvas,
                font,
                &texture_creator,
                &media_text,
                50,
                10,
                Color::WHITE,
            )?;

            // Cache info
            let cache_used_mb = info.cache_used as f64 / 1024.0 / 1024.0;
            let cache_max_mb = info.cache_max as f64 / 1024.0 / 1024.0;
            let cache_text = format!(
                "Cache: {:.1}MB / {:.1}MB ({} items)",
                cache_used_mb, cache_max_mb, info.cache_items
            );
            Self::render_text(
                &mut self.canvas,
                font,
                &texture_creator,
                &cache_text,
                50,
                35,
                Color::RGB(200, 200, 200),
            )?;

            // Connection status text (right side)
            let conn_text = if info.is_offline {
                "OFFLINE"
            } else if info.is_connected {
                "CONNECTED"
            } else {
                "CONNECTING..."
            };
            let text_width = (conn_text.len() * 12) as i32; // Approximate
            Self::render_text(
                &mut self.canvas,
                font,
                &texture_creator,
                conn_text,
                self.screen_width as i32 - text_width - 20,
                20,
                indicator_color,
            )?;
        }

        // Video progress bar (if playing video)
        if info.is_video {
            if let (Some(pos), Some(dur)) = (info.video_position, info.video_duration) {
                let bar_y = self.screen_height as i32 - 10;
                let bar_width = self.screen_width - 40;
                let progress = (pos / dur).min(1.0);

                // Background
                self.canvas.set_draw_color(Color::RGBA(100, 100, 100, 150));
                self.canvas
                    .fill_rect(Rect::new(20, bar_y, bar_width, 6))
                    .map_err(|e| anyhow::anyhow!("Failed to draw progress bg: {}", e))?;

                // Progress
                let progress_width = (bar_width as f32 * progress) as u32;
                if progress_width > 0 {
                    self.canvas.set_draw_color(Color::RGB(100, 200, 255));
                    self.canvas
                        .fill_rect(Rect::new(20, bar_y, progress_width, 6))
                        .map_err(|e| anyhow::anyhow!("Failed to draw progress: {}", e))?;
                }
            }
        }

        Ok(())
    }

    /// Render info overlays for all panels in the current multi-image layout.
    pub fn render_info_overlay_multi(&mut self, infos: &[MediaInfoOverlay]) -> Result<()> {
        for (i, info) in infos.iter().enumerate() {
            if i >= 4 {
                break;
            }
            let rect = self.last_image_rects[i]
                .unwrap_or_else(|| Rect::new(0, 0, self.screen_width, self.screen_height));
            self.render_info_overlay_in_rect(info, rect)?;
        }
        Ok(())
    }

    pub fn render_info_overlay(&mut self, info: &MediaInfoOverlay) -> Result<()> {
        let rect = self.last_image_rects[0]
            .unwrap_or_else(|| Rect::new(0, 0, self.screen_width, self.screen_height));
        self.render_info_overlay_in_rect(info, rect)
    }

    /// Render info overlay text anchored to the bottom-left of the given image rect.
    fn render_info_overlay_in_rect(
        &mut self,
        info: &MediaInfoOverlay,
        image_rect: Rect,
    ) -> Result<()> {
        let Some(font) = &self.font_info else {
            return Ok(());
        };

        let line_h = 24i32;
        let margin = (image_rect.width().min(image_rect.height()) as f32 * 0.03).round() as i32;
        let text_x = image_rect.x() + margin;
        let mut lines: Vec<String> = Vec::new();

        if let Some(t) = &info.title {
            if !t.is_empty() {
                lines.push(t.clone());
            }
        }
        if let Some(d) = &info.description {
            if !d.is_empty() {
                lines.push(d.clone());
            }
        }
        if let Some(l) = &info.location {
            if !l.is_empty() {
                lines.push(l.clone());
            }
        }
        if !info.tags.is_empty() {
            lines.push(info.tags.join("  ·  "));
        }
        if let Some(ta) = &info.taken_at {
            if !ta.is_empty() {
                lines.push(ta.clone());
            }
        }

        // Camera make + model line
        let camera = match (&info.camera_make, &info.camera_model) {
            (Some(make), Some(model)) if !make.is_empty() && !model.is_empty() => {
                if model.to_lowercase().starts_with(&make.to_lowercase()) {
                    Some(model.clone())
                } else {
                    Some(format!("{} {}", make, model))
                }
            }
            (Some(make), None) if !make.is_empty() => Some(make.clone()),
            (None, Some(model)) if !model.is_empty() => Some(model.clone()),
            _ => None,
        };
        if let Some(c) = camera {
            lines.push(c);
        }

        // Technical line: focal length · f-number · exposure · ISO
        let mut tech_parts: Vec<String> = Vec::new();
        if let Some(fl) = &info.focal_length {
            if !fl.is_empty() {
                tech_parts.push(fl.clone());
            }
        }
        if let Some(fn_) = &info.f_number {
            if !fn_.is_empty() {
                tech_parts.push(fn_.clone());
            }
        }
        if let Some(et) = &info.exposure_time {
            if !et.is_empty() {
                tech_parts.push(et.clone());
            }
        }
        if let Some(iso) = &info.iso {
            if !iso.is_empty() {
                tech_parts.push(format!("ISO {}", iso));
            }
        }
        if !tech_parts.is_empty() {
            lines.push(tech_parts.join("  ·  "));
        }

        if let Some((w, h)) = info.dimensions {
            lines.push(format!("{}×{}", w, h));
        }

        if lines.is_empty() {
            return Ok(());
        }

        let texture_creator = self.canvas.texture_creator();
        let total_h = lines.len() as i32 * line_h;
        let start_y = image_rect.y() + image_rect.height() as i32 - total_h - margin;

        for (i, line) in lines.iter().enumerate() {
            let y = start_y + i as i32 * line_h;
            Self::render_text(
                &mut self.canvas,
                font,
                &texture_creator,
                line,
                text_x,
                y,
                Color::RGBA(255, 255, 255, 210),
            )?;
        }

        Ok(())
    }

    /// Draw a filled circle (approximated with rectangles for simplicity).
    fn draw_filled_circle(&mut self, cx: i32, cy: i32, radius: i32, color: Color) -> Result<()> {
        self.canvas.set_draw_color(color);
        for dy in -radius..=radius {
            let dx = ((radius * radius - dy * dy) as f32).sqrt() as i32;
            self.canvas
                .fill_rect(Rect::new(cx - dx, cy + dy, (dx * 2) as u32, 1))
                .map_err(|e| anyhow::anyhow!("Failed to draw circle: {}", e))?;
        }
        Ok(())
    }

    /// Render the discovery/pairing screen shown when no device_id is configured.
    pub fn render_discovery_screen(&mut self, pin: &str, ip: &str) -> Result<()> {
        self.canvas.set_draw_color(Color::RGB(10, 18, 35));
        self.canvas.clear();

        if let (Some(font_small), Some(font_label), Some(font_pin)) = (
            &self.font_discovery_small,
            &self.font_discovery_label,
            &self.font_discovery_pin,
        ) {
            let tc = self.canvas.texture_creator();

            let cx = (self.screen_width / 2) as i32;
            let cy = (self.screen_height / 2) as i32;

            // "Spomienka" title
            Self::render_text_centered(
                &mut self.canvas,
                font_label,
                &tc,
                "Spomienka",
                cx,
                cy - 200,
                Color::RGB(180, 200, 240),
            )?;

            // Instruction line
            Self::render_text_centered(
                &mut self.canvas,
                font_small,
                &tc,
                "Open the admin panel and go to Settings",
                cx,
                cy - 140,
                Color::RGB(140, 160, 200),
            )?;
            Self::render_text_centered(
                &mut self.canvas,
                font_small,
                &tc,
                "to add this viewer. Enter the PIN below:",
                cx,
                cy - 100,
                Color::RGB(140, 160, 200),
            )?;

            // PIN label
            Self::render_text_centered(
                &mut self.canvas,
                font_small,
                &tc,
                "PIN",
                cx,
                cy - 40,
                Color::RGB(100, 130, 180),
            )?;

            // PIN value — large, bright, formatted as "123 456"
            let pin_display = format!("{} {}", &pin[..3], &pin[3..]);
            Self::render_text_centered(
                &mut self.canvas,
                font_pin,
                &tc,
                &pin_display,
                cx,
                cy - 10,
                Color::RGB(255, 230, 100),
            )?;

            // IP address
            let ip_text = format!("IP: {}", ip);
            Self::render_text_centered(
                &mut self.canvas,
                font_small,
                &tc,
                &ip_text,
                cx,
                cy + 110,
                Color::RGB(100, 130, 180),
            )?;

            // Searching indicator
            Self::render_text_centered(
                &mut self.canvas,
                font_small,
                &tc,
                "Waiting for admin to connect...",
                cx,
                cy + 155,
                Color::RGB(80, 110, 160),
            )?;
        }

        self.canvas.present();
        Ok(())
    }

    fn render_text_centered(
        canvas: &mut Canvas<Window>,
        font: &sdl2::ttf::Font,
        texture_creator: &TextureCreator<WindowContext>,
        text: &str,
        cx: i32,
        y: i32,
        color: Color,
    ) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        let surface = font
            .render(text)
            .blended(color)
            .map_err(|e| anyhow::anyhow!("Render text: {}", e))?;
        let texture = texture_creator
            .create_texture_from_surface(&surface)
            .map_err(|e| anyhow::anyhow!("Text texture: {}", e))?;
        let query = texture.query();
        let x = cx - (query.width as i32 / 2);
        let dest = Rect::new(x, y, query.width, query.height);
        canvas
            .copy(&texture, None, dest)
            .map_err(|e| anyhow::anyhow!("Copy text: {}", e))?;
        Ok(())
    }

    /// Render text with a soft multi-offset shadow for legibility on any background.
    /// Draws a dark shadow at several small offsets (simulating a blur), then the
    /// foreground text on top — elegant and readable without any opaque background box.
    fn render_text(
        canvas: &mut Canvas<Window>,
        font: &sdl2::ttf::Font,
        texture_creator: &TextureCreator<WindowContext>,
        text: &str,
        x: i32,
        y: i32,
        color: Color,
    ) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }

        // Warm dark brown shadow — softer and less harsh than pure black
        let shadow_surface = font
            .render(text)
            .blended(Color::RGBA(28, 14, 6, 200))
            .map_err(|e| anyhow::anyhow!("Failed to render text shadow: {}", e))?;
        let shadow_tex = texture_creator
            .create_texture_from_surface(&shadow_surface)
            .map_err(|e| anyhow::anyhow!("Failed to create text shadow texture: {}", e))?;
        let q = shadow_tex.query();

        let offsets: &[(i32, i32, u8)] = &[
            (-2, 0, 60),
            (2, 0, 60),
            (0, -2, 60),
            (0, 2, 60),
            (-2, -2, 35),
            (2, -2, 35),
            (-2, 2, 35),
            (2, 2, 35),
        ];
        for &(dx, dy, a) in offsets {
            let mut t = texture_creator
                .create_texture_from_surface(&shadow_surface)
                .map_err(|e| anyhow::anyhow!("Failed to duplicate shadow texture: {}", e))?;
            t.set_alpha_mod(a);
            canvas
                .copy(&t, None, Rect::new(x + dx, y + dy, q.width, q.height))
                .map_err(|e| anyhow::anyhow!("Failed to copy shadow: {}", e))?;
        }

        let surface = font
            .render(text)
            .blended(color)
            .map_err(|e| anyhow::anyhow!("Failed to render text: {}", e))?;
        let texture = texture_creator
            .create_texture_from_surface(&surface)
            .map_err(|e| anyhow::anyhow!("Failed to create text texture: {}", e))?;
        canvas
            .copy(&texture, None, Rect::new(x, y, q.width, q.height))
            .map_err(|e| anyhow::anyhow!("Failed to copy text: {}", e))?;

        Ok(())
    }
}
