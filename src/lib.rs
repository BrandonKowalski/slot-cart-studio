//! slot cart studio. Four of slot's own source files are compiled here unchanged, so a preview
//! is the device's cart face rather than an imitation of it. They reach each other through
//! `crate::` paths, which is why they sit at the root. `art` is the one module swapped out:
//! slot's reads a label from disk, and a browser has no disk.

#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../slot/crates/slot-ui/src/cart.rs"]
mod cart;
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../slot/crates/slot-ui/src/shell.rs"]
mod shell;
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../slot/crates/slot-ui/src/silhouette.rs"]
mod silhouette;
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../slot/crates/slot-ui/src/text.rs"]
mod text;

mod art;
pub mod face;

use wasm_bindgen::prelude::*;

/// The cart face's size, `[w, h]`, so the page sizes its canvases from slot.
#[wasm_bindgen]
pub fn cart_size() -> Vec<u32> {
    vec![cart::CART_W, cart::CART_H]
}

/// A label the card already has, on its cart.
#[wasm_bindgen]
pub fn existing_face(png: &[u8], code: &str, stem: &str) -> Vec<u8> {
    face::from_png(png, code, stem)
}
