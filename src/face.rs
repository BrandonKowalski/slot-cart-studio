//! A cart face for a label held in memory, drawn by slot's own `cart_face`.

use std::path::{Path, PathBuf};

use crate::{art, cart};

/// Slot's `cart_face` reads a cart's label through `art::cover`. The studio's `art` answers from
/// a stash, so the cart names the stash key where a file path would go. The title is left empty
/// because slot's generated label is titled from the stem, not the header.
fn draw(code: &str, stem: &str, key: &Path) -> Vec<u8> {
    cart::cart_face(&slot_store::Cart {
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
pub fn from_png(png: &[u8], code: &str, stem: &str) -> Vec<u8> {
    art::with_png(png, |key| draw(code, stem, key))
}

/// Straight RGBA, `w` by `h`: a label composed in memory, shown without a PNG round trip.
pub fn from_rgba(rgba: &[u8], w: u32, h: u32, code: &str, stem: &str) -> Vec<u8> {
    art::with_rgba(rgba, w, h, |key| draw(code, stem, key))
}
