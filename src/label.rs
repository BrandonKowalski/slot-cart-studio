//! The house style: a game's logo on a two-stop diagonal gradient, 1280x640.

use resvg::tiny_skia::{FilterQuality, IntSize, Pixmap, PixmapPaint, Transform};

use crate::{art, face, hue};

pub const W: u32 = 1280;
pub const H: u32 = 640;
const BOX_W: f32 = 920.0;
const BOX_H: f32 = 423.0;
/// Where a logo that fills the box's height starts. A wider logo centres on `MID_ROW` instead.
const TALL_TOP: f32 = 70.0;
const MID_ROW: f32 = 320.0;
/// Bounds ignore the faint fringe some rips carry around a logo.
const ALPHA_EDGE: u8 = 16;

/// Deep top left, pale bottom right, one hue: the lightness and saturation the hand-made labels
/// on slot's card sit at.
pub fn stops(hue: u16) -> ([u8; 3], [u8; 3]) {
    let h = hue as f32;
    (
        hue::hsl_to_rgb(h, 0.75, 0.34),
        hue::hsl_to_rgb(h, 0.80, 0.82),
    )
}

/// Opaque RGBA. The gradient leans on x far more than y, so it reads as diagonal on a wide label.
pub fn gradient(hue: u16) -> Vec<u8> {
    let (deep, pale) = stops(hue);
    let mut px = Vec::with_capacity((W * H * 4) as usize);
    for y in 0..H {
        for x in 0..W {
            let t = 0.88 * x as f32 / W as f32 + 0.12 * y as f32 / H as f32;
            for c in 0..3 {
                px.push((deep[c] as f32 + (pale[c] as f32 - deep[c] as f32) * t).round() as u8);
            }
            px.push(255);
        }
    }
    px
}

/// The visible part of a logo as `(x0, y0, x1, y1)`, far edges exclusive. `None` when nothing
/// is visible.
pub fn trim(rgba: &[u8], w: u32, h: u32) -> Option<(u32, u32, u32, u32)> {
    let mut bounds: Option<(u32, u32, u32, u32)> = None;
    for y in 0..h {
        for x in 0..w {
            if rgba[((y * w + x) * 4 + 3) as usize] < ALPHA_EDGE {
                continue;
            }
            bounds = Some(match bounds {
                None => (x, y, x + 1, y + 1),
                Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1)),
            });
        }
    }
    bounds
}

/// Scale and top left for a trimmed logo: one factor that fits the 920x423 box, centred across.
pub fn placement(w: u32, h: u32) -> (f32, f32, f32) {
    let by_w = BOX_W / w as f32;
    let by_h = BOX_H / h as f32;
    let scale = by_w.min(by_h);
    let x = (W as f32 - w as f32 * scale) / 2.0;
    let y = if by_h <= by_w {
        TALL_TOP
    } else {
        MID_ROW - h as f32 * scale / 2.0
    };
    (scale, x, y)
}

/// The logo's visible part, premultiplied, because that is what tiny-skia draws.
fn premultiplied(logo: &[u8], w: u32, (x0, y0, x1, y1): (u32, u32, u32, u32)) -> Vec<u8> {
    let mut out = Vec::with_capacity(((x1 - x0) * (y1 - y0) * 4) as usize);
    for y in y0..y1 {
        for x in x0..x1 {
            let i = ((y * w + x) * 4) as usize;
            let a = logo[i + 3] as u32;
            for c in 0..3 {
                out.push(((logo[i + c] as u32 * a + 127) / 255) as u8);
            }
            out.push(a as u8);
        }
    }
    out
}

/// The logo over the gradient, as opaque RGBA.
pub fn compose(logo: &[u8], w: u32, h: u32, hue: u16) -> Vec<u8> {
    let ground = gradient(hue);
    let Some(bounds) = trim(logo, w, h) else {
        return ground;
    };
    let (tw, th) = (bounds.2 - bounds.0, bounds.3 - bounds.1);
    let Some(src) = IntSize::from_wh(tw, th)
        .and_then(|size| Pixmap::from_vec(premultiplied(logo, w, bounds), size))
    else {
        return ground;
    };
    let size = IntSize::from_wh(W, H).expect("the label's size is not zero");
    let mut dst = Pixmap::from_vec(ground, size).expect("the gradient is W by H");
    let (scale, x, y) = placement(tw, th);
    let paint = PixmapPaint {
        quality: FilterQuality::Bicubic,
        ..PixmapPaint::default()
    };
    dst.draw_pixmap(
        0,
        0,
        src.as_ref(),
        &paint,
        Transform::from_row(scale, 0.0, 0.0, scale, x, y),
        None,
    );
    // The ground is opaque everywhere, so premultiplied and straight are the same bytes.
    dst.take()
}

/// One logo, recomposed whenever its hue moves.
pub struct Label {
    logo: Vec<u8>,
    w: u32,
    h: u32,
    hue: u16,
    rgba: Vec<u8>,
}

impl Label {
    /// `None` for bytes slot's decoder would refuse.
    pub fn from_png(png: &[u8], hue: u16) -> Option<Label> {
        let (logo, w, h) = art::decode(png)?;
        let hue = hue % 360;
        let rgba = compose(&logo, w, h, hue);
        Some(Label {
            logo,
            w,
            h,
            hue,
            rgba,
        })
    }

    pub fn hue(&self) -> u16 {
        self.hue
    }

    pub fn set_hue(&mut self, hue: u16) {
        self.hue = hue % 360;
        self.rgba = compose(&self.logo, self.w, self.h, self.hue);
    }

    /// Slot's cart face with this label on it.
    pub fn face(&self, code: &str, stem: &str) -> Vec<u8> {
        face::from_rgba(&self.rgba, W, H, code, stem)
    }

    /// Opaque 8-bit RGB, which is all a card's label needs.
    pub fn png(&self) -> Vec<u8> {
        let rgb: Vec<u8> = self
            .rgba
            .chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect();
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, W, H);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header()
                .expect("a PNG header writes into a Vec")
                .write_image_data(&rgb)
                .expect("PNG data writes into a Vec");
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INK: [u8; 4] = [10, 200, 30, 255];

    fn solid(w: u32, h: u32) -> Vec<u8> {
        INK.repeat((w * h) as usize)
    }

    fn at(rgba: &[u8], x: u32, y: u32) -> [u8; 3] {
        let i = ((y * W + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2]]
    }

    /// The first and last rows, down column 640, where the label isn't bare gradient.
    fn logo_rows(label: &[u8], hue: u16) -> (u32, u32) {
        let ground = gradient(hue);
        let rows: Vec<u32> = (0..H)
            .filter(|y| at(label, 640, *y) != at(&ground, 640, *y))
            .collect();
        (rows[0], *rows.last().expect("a logo row"))
    }

    fn near(a: [u8; 3], b: [u8; 3], by: i32) -> bool {
        (0..3).all(|c| (a[c] as i32 - b[c] as i32).abs() <= by)
    }

    #[test]
    fn the_corners_are_the_stops() {
        let (deep, pale) = stops(200);
        let g = gradient(200);
        assert_eq!(at(&g, 0, 0), deep);
        // The house formula puts t at 0.9991 here, not 1.
        assert!(near(at(&g, W - 1, H - 1), pale, 1));
    }

    #[test]
    fn the_stops_are_the_house_lightness_and_saturation() {
        assert_eq!(
            stops(0),
            (
                hue::hsl_to_rgb(0.0, 0.75, 0.34),
                hue::hsl_to_rgb(0.0, 0.80, 0.82)
            )
        );
    }

    #[test]
    fn a_tall_logo_fills_rows_70_to_493() {
        let label = compose(&solid(100, 100), 100, 100, 30);
        let (first, last) = logo_rows(&label, 30);
        assert!((69..=71).contains(&first), "first logo row {first}");
        assert!((491..=493).contains(&last), "last logo row {last}");
        assert!(near(at(&label, 640, 280), [INK[0], INK[1], INK[2]], 2));
    }

    #[test]
    fn a_wide_logo_centres_on_row_320() {
        let label = compose(&solid(400, 40), 400, 40, 30);
        let (first, last) = logo_rows(&label, 30);
        let mid = (first + last) as f32 / 2.0;
        assert!((mid - 320.0).abs() <= 1.0, "logo centred on row {mid}");
        // 920 wide from 400 is a scale of 2.3, so 92 rows.
        assert!((90..=93).contains(&(last - first)), "rows {first}..{last}");
    }

    #[test]
    fn transparent_margins_and_a_faint_fringe_do_not_count() {
        let mut logo = vec![0u8; 200 * 200 * 4];
        for y in 50..150 {
            for x in 50..150 {
                let i = (y * 200 + x) * 4;
                logo[i..i + 4].copy_from_slice(&INK);
            }
        }
        logo[3] = 15;
        assert_eq!(trim(&logo, 200, 200), Some((50, 50, 150, 150)));
        assert!(compose(&logo, 200, 200, 30) == compose(&solid(100, 100), 100, 100, 30));
    }

    #[test]
    fn an_invisible_logo_leaves_the_bare_gradient() {
        assert!(compose(&[0u8; 16 * 16 * 4], 16, 16, 90) == gradient(90));
    }

    #[test]
    fn the_png_is_1280_by_640_rgb() {
        let mut logo = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut logo, 8, 4);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header()
                .unwrap()
                .write_image_data(&solid(8, 4))
                .unwrap();
        }
        let label = Label::from_png(&logo, 45).expect("logo decodes");
        assert_eq!(label.hue(), 45);
        let out = label.png();
        let reader = png::Decoder::new(std::io::Cursor::new(out))
            .read_info()
            .unwrap();
        let info = reader.info();
        assert_eq!(
            (info.width, info.height, info.color_type, info.bit_depth),
            (W, H, png::ColorType::Rgb, png::BitDepth::Eight)
        );
    }

    #[test]
    fn bytes_that_are_not_a_png_make_no_label() {
        assert!(Label::from_png(b"not a png", 0).is_none());
    }
}
