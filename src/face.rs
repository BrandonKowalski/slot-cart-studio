//! A cart face for a label held in memory, drawn by slot's own `cart_face`.

use std::path::{Path, PathBuf};

use resvg::tiny_skia::{FilterQuality, IntSize, Pixmap, PixmapPaint, Transform};
use slot_store::Platform;

use crate::{art, cart};

/// A photograph of the cart, shown as the whole cart rather than as a label on a drawn one.
///
/// Deliberately not `cart_face`: the point of this mode is the cartridge that exists, so none of
/// slot's shell is drawn under or around it. The picture is fitted to the box its platform's
/// carts are drawn in and centred there, clear on every side, so it sits on the shelf the way any
/// other face does.
pub fn scan_whole(png: &[u8], platform: Platform) -> Vec<u8> {
    let (bw, bh) = cart::cart_box(platform);
    let blank = vec![0u8; (bw * bh * 4) as usize];
    let Some((src, w, h)) = art::decode(png) else {
        return blank;
    };
    let Some(size) = IntSize::from_wh(w, h) else {
        return blank;
    };
    // tiny-skia draws premultiplied; `art::decode` hands back straight alpha.
    let mut premul = Vec::with_capacity(src.len());
    for px in src.chunks_exact(4) {
        let a = px[3] as u32;
        for &v in &px[..3] {
            premul.push(((v as u32 * a + 127) / 255) as u8);
        }
        premul.push(px[3]);
    }
    let (Some(from), Some(mut dst)) = (Pixmap::from_vec(premul, size), Pixmap::new(bw, bh)) else {
        return blank;
    };
    let scale = (bw as f32 / w as f32).min(bh as f32 / h as f32);
    dst.draw_pixmap(
        0,
        0,
        from.as_ref(),
        &PixmapPaint {
            quality: FilterQuality::Bicubic,
            ..PixmapPaint::default()
        },
        Transform::from_row(
            scale,
            0.0,
            0.0,
            scale,
            (bw as f32 - w as f32 * scale) / 2.0,
            (bh as f32 - h as f32 * scale) / 2.0,
        ),
        None,
    );
    // Back to straight alpha, which is what the page puts into an ImageData.
    let mut out = dst.take();
    for px in out.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a == 0 || a == 255 {
            continue;
        }
        for v in px[..3].iter_mut() {
            *v = ((*v as u32 * 255 + a / 2) / a).min(255) as u8;
        }
    }
    out
}

/// The platform a card folder names. `cart_face` does not read this field: slot draws one cart
/// silhouette, so a Game Boy cart wears the same shape a GBA one does and the preview stays
/// whatever slot itself would draw. It is set anyway, because a `Cart` should say where its rom
/// actually sits, and because the day slot gives the Game Boy its own art this picks it up.
/// Anything unrecognised is GBA, which is the folder the page falls back to as well.
pub fn platform_of(dir: &str) -> Platform {
    match dir {
        "GB" => Platform::Gb,
        "GBC" => Platform::Gbc,
        _ => Platform::Gba,
    }
}

/// Slot's `cart_face` reads a cart's label through `art::cover`. The studio's `art` answers from
/// a stash, so the cart names the stash key where a file path would go. The title is left empty
/// because slot's generated label is titled from the stem, not the header.
fn draw(platform: Platform, code: &str, stem: &str, key: &Path) -> Vec<u8> {
    cart::cart_face(&slot_store::Cart {
        platform,
        stem: stem.to_string(),
        rom: PathBuf::new(),
        label: Some(key.to_path_buf()),
        title: String::new(),
        code: code.to_string(),
    })
    .rgba
}

/// PNG bytes as a card holds them. Bytes that don't decode fall back to slot's generated label,
/// as they do on the device.
pub fn from_png(png: &[u8], platform: Platform, code: &str, stem: &str) -> Vec<u8> {
    art::with_png(png, |key| draw(platform, code, stem, key))
}

/// Straight RGBA, `w` by `h`: a label composed in memory, shown without a PNG round trip.
pub fn from_rgba(
    rgba: &[u8],
    w: u32,
    h: u32,
    platform: Platform,
    code: &str,
    stem: &str,
) -> Vec<u8> {
    art::with_rgba(rgba, w, h, |key| draw(platform, code, stem, key))
}
