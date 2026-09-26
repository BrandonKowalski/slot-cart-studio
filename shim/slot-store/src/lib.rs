//! slot-store as slot's cart face sees it, with one function swapped. `gb::class` opens the rom
//! for its CGB flag, which a browser cannot do, so this one answers from a flag the page read.

pub use ::slot_store_real::*;

pub mod gb {
    use std::cell::Cell;
    use std::path::Path;

    pub use ::slot_store_real::gb::*;

    const KEY: &str = "stash:rom";

    thread_local! {
        static FLAG: Cell<Option<u8>> = const { Cell::new(None) };
    }

    /// Runs `f` with a rom key whose CGB flag is `flag`, for the length of one draw.
    pub fn with_flag<R>(flag: u8, f: impl FnOnce(&Path) -> R) -> R {
        FLAG.with(|s| s.set(Some(flag)));
        let out = f(Path::new(KEY));
        FLAG.with(|s| s.set(None));
        out
    }

    /// Slot's signature and slot's rule; any other path is slot's own `class`.
    pub fn class(rom: &Path) -> Class {
        match FLAG.with(Cell::get).filter(|_| rom == Path::new(KEY)) {
            Some(0xc0) => Class::ColourOnly,
            Some(0x80) => Class::DualMode,
            Some(_) => Class::Original,
            None => ::slot_store_real::gb::class(rom),
        }
    }
}
