# Rust third-party notices

`libssh_core.so` (Android) and `libssh_core.a` (iOS) link every crate below into the app, so their
licences travel with the shipped binaries. The table is generated from
`cargo metadata --format-version 1` over the normal dependency closure of `ssh-core`, and
`cargo test -p ssh-core --test notices` fails when it drifts from the lockfile: do not edit it by
hand.

Where a crate offers a choice of licences, this project takes Apache-2.0 or MIT, or the other
permissive option the crate names. The full texts are in `THIRD_PARTY_NOTICES.md`: Apache-2.0
(Appendix A), MIT (Appendix B), BSD-3-Clause (Appendix C), ISC (Appendix D), Mozilla Public
License 2.0 (Appendix E) and the Unicode License V3 (Appendix F). The `uniffi` crates are the only
MPL-2.0 code here and are used unmodified from crates.io, which is where their source is
published.

| crate | version | licence | source |
| --- | --- | --- | --- |
| `aead` | `0.5.2` | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `aead` | `0.6.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `aes` | `0.9.4` | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-ciphers |
| `aes-gcm` | `0.11.1` | Apache-2.0 OR MIT | https://github.com/RustCrypto/AEADs |
| `age` | `0.11.5` | MIT OR Apache-2.0 | https://github.com/str4d/rage |
| `age-core` | `0.11.0` | MIT OR Apache-2.0 | https://github.com/str4d/rage |
| `android_system_properties` | `0.1.6` | MIT OR Apache-2.0 | https://github.com/nical/android_system_properties |
| `anstyle` | `1.0.14` | MIT OR Apache-2.0 | https://github.com/rust-cli/anstyle.git |
| `anyhow` | `1.0.104` | MIT OR Apache-2.0 | https://github.com/dtolnay/anyhow |
| `arc-swap` | `1.9.5` | MIT OR Apache-2.0 | https://github.com/vorner/arc-swap |
| `argon2` | `0.6.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/password-hashes |
| `askama` | `0.16.1` | MIT OR Apache-2.0 | https://github.com/askama-rs/askama |
| `askama_derive` | `0.16.1` | MIT OR Apache-2.0 | https://github.com/askama-rs/askama |
| `askama_macros` | `0.16.1` | MIT OR Apache-2.0 | https://github.com/askama-rs/askama |
| `askama_parser` | `0.16.1` | MIT OR Apache-2.0 | https://github.com/askama-rs/askama |
| `async-trait` | `0.1.92` | MIT OR Apache-2.0 | https://github.com/dtolnay/async-trait |
| `base16ct` | `1.0.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `base64` | `0.21.7` | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| `base64ct` | `1.8.3` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `basic-toml` | `0.1.10` | MIT OR Apache-2.0 | https://github.com/dtolnay/basic-toml |
| `bcrypt-pbkdf` | `0.11.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/password-hashes |
| `bech32` | `0.9.1` | MIT | https://github.com/rust-bitcoin/rust-bech32 |
| `bitflags` | `2.13.2` | MIT OR Apache-2.0 | https://github.com/bitflags/bitflags |
| `blake2` | `0.11.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| `block-buffer` | `0.10.4` | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `block-buffer` | `0.12.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `block-padding` | `0.4.2` | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `blowfish` | `0.10.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-ciphers |
| `bumpalo` | `3.20.3` | MIT OR Apache-2.0 | https://github.com/fitzgen/bumpalo |
| `byteorder` | `1.5.0` | Unlicense OR MIT | https://github.com/BurntSushi/byteorder |
| `bytes` | `1.12.1` | MIT | https://github.com/tokio-rs/bytes |
| `camino` | `1.2.6` | MIT OR Apache-2.0 | https://github.com/camino-rs/camino |
| `cbc` | `0.2.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-modes |
| `cfg-if` | `1.0.5` | MIT OR Apache-2.0 | https://github.com/rust-lang/cfg-if |
| `chacha20` | `0.10.2` | MIT OR Apache-2.0 | https://github.com/RustCrypto/stream-ciphers |
| `chacha20` | `0.9.1` | Apache-2.0 OR MIT | https://github.com/RustCrypto/stream-ciphers |
| `chacha20poly1305` | `0.10.1` | Apache-2.0 OR MIT | https://github.com/RustCrypto/AEADs/tree/master/chacha20poly1305 |
| `chrono` | `0.4.45` | MIT OR Apache-2.0 | https://github.com/chronotope/chrono |
| `cipher` | `0.4.4` | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `cipher` | `0.5.2` | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `clap` | `4.6.7` | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| `clap_builder` | `4.6.7` | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| `clap_derive` | `4.6.7` | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| `clap_lex` | `1.1.1` | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| `cmov` | `0.5.4` | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| `const-oid` | `0.10.3` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `cookie-factory` | `0.3.3` | MIT | https://github.com/rust-bakery/cookie-factory |
| `core-foundation-sys` | `0.8.7` | MIT OR Apache-2.0 | https://github.com/servo/core-foundation-rs |
| `cpubits` | `0.1.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `cpufeatures` | `0.2.17` | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `cpufeatures` | `0.3.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `crossbeam-utils` | `0.8.23` | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| `crypto-bigint` | `0.7.11` | Apache-2.0 OR MIT | https://github.com/RustCrypto/crypto-bigint |
| `crypto-common` | `0.1.7` | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `crypto-common` | `0.2.2` | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `crypto-primes` | `0.7.2` | Apache-2.0 OR MIT | https://github.com/entropyxyz/crypto-primes |
| `ctr` | `0.10.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-modes |
| `ctutils` | `0.4.8` | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| `curve25519-dalek` | `4.1.3` | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/curve25519-dalek |
| `curve25519-dalek` | `5.0.0` | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/curve25519-dalek |
| `curve25519-dalek-derive` | `0.1.1` | MIT/Apache-2.0 | https://github.com/dalek-cryptography/curve25519-dalek |
| `dashmap` | `6.2.1` | MIT | https://github.com/xacrimon/dashmap |
| `data-encoding` | `2.11.1` | MIT | https://github.com/ia0/data-encoding |
| `delegate` | `0.13.5` | MIT OR Apache-2.0 | https://github.com/kobzol/rust-delegate |
| `der` | `0.8.3` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `des` | `0.9.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-ciphers |
| `digest` | `0.10.7` | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `digest` | `0.11.3` | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `displaydoc` | `0.2.7` | MIT OR Apache-2.0 | https://github.com/yaahc/displaydoc |
| `ecdsa` | `0.17.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures |
| `ed25519` | `3.0.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures |
| `ed25519-dalek` | `3.0.0` | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/ed25519-dalek |
| `elliptic-curve` | `0.14.3` | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| `enum_dispatch` | `0.3.13` | MIT OR Apache-2.0 | https://gitlab.com/antonok/enum_dispatch |
| `equivalent` | `1.0.3` | Apache-2.0 OR MIT | https://github.com/indexmap-rs/equivalent |
| `errno` | `0.3.15` | MIT OR Apache-2.0 | https://github.com/lambda-fairy/rust-errno |
| `fastrand` | `2.5.0` | Apache-2.0 OR MIT | https://github.com/smol-rs/fastrand |
| `ff` | `0.14.0` | MIT/Apache-2.0 | https://github.com/zkcrypto/ff |
| `fiat-crypto` | `0.2.9` | MIT OR Apache-2.0 OR BSD-1-Clause | https://github.com/mit-plv/fiat-crypto |
| `fiat-crypto` | `0.3.0` | MIT OR Apache-2.0 OR BSD-1-Clause | https://github.com/mit-plv/fiat-crypto |
| `find-crate` | `0.6.3` | Apache-2.0 OR MIT | https://github.com/taiki-e/find-crate |
| `fluent` | `0.16.1` | Apache-2.0 OR MIT | https://github.com/projectfluent/fluent-rs |
| `fluent-bundle` | `0.15.3` | Apache-2.0 OR MIT | https://github.com/projectfluent/fluent-rs |
| `fluent-langneg` | `0.13.1` | Apache-2.0 OR MIT | https://github.com/projectfluent/fluent-langneg-rs |
| `fluent-syntax` | `0.11.1` | Apache-2.0 OR MIT | https://github.com/projectfluent/fluent-rs |
| `fs-err` | `3.3.2` | MIT OR Apache-2.0 | https://github.com/andrewhickman/fs-err |
| `futures` | `0.3.34` | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| `futures-channel` | `0.3.34` | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| `futures-core` | `0.3.34` | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| `futures-executor` | `0.3.34` | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| `futures-io` | `0.3.34` | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| `futures-macro` | `0.3.34` | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| `futures-sink` | `0.3.34` | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| `futures-task` | `0.3.34` | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| `futures-util` | `0.3.34` | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| `generic-array` | `0.14.7` | MIT | https://github.com/fizyk20/generic-array.git |
| `generic-array` | `1.4.5` | MIT | https://github.com/fizyk20/generic-array.git |
| `getrandom` | `0.2.17` | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| `getrandom` | `0.4.3` | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| `ghash` | `0.6.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| `glob` | `0.3.4` | MIT OR Apache-2.0 | https://github.com/rust-lang/glob |
| `gloo-timers` | `0.4.0` | MIT OR Apache-2.0 | https://github.com/rustwasm/gloo/tree/master/crates/timers |
| `goblin` | `0.8.2` | MIT | https://github.com/m4b/goblin |
| `group` | `0.14.0` | MIT/Apache-2.0 | https://github.com/zkcrypto/group |
| `hashbrown` | `0.14.5` | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| `hashbrown` | `0.17.1` | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| `heck` | `0.5.0` | MIT OR Apache-2.0 | https://github.com/withoutboats/heck |
| `hex` | `0.4.3` | MIT OR Apache-2.0 | https://github.com/KokaKiwi/rust-hex |
| `hex-literal` | `1.1.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `hkdf` | `0.12.4` | MIT OR Apache-2.0 | https://github.com/RustCrypto/KDFs/ |
| `hkdf` | `0.13.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/KDFs/ |
| `hmac` | `0.12.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/MACs |
| `hmac` | `0.13.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/MACs |
| `hybrid-array` | `0.4.15` | MIT OR Apache-2.0 | https://github.com/RustCrypto/hybrid-array |
| `i18n-config` | `0.4.8` | MIT | https://github.com/kellpossible/cargo-i18n/tree/master/i18n-config |
| `i18n-embed` | `0.15.4` | MIT | https://github.com/kellpossible/cargo-i18n/tree/master/i18n-embed |
| `i18n-embed-fl` | `0.9.4` | MIT | https://github.com/kellpossible/cargo-i18n/tree/master/i18n-embed-fl |
| `i18n-embed-impl` | `0.8.4` | MIT | https://github.com/kellpossible/cargo-i18n/tree/master/i18n-embed |
| `iana-time-zone` | `0.1.65` | MIT OR Apache-2.0 | https://github.com/strawlab/iana-time-zone |
| `iana-time-zone-haiku` | `0.1.2` | MIT OR Apache-2.0 | https://github.com/strawlab/iana-time-zone |
| `indexmap` | `2.14.2` | Apache-2.0 OR MIT | https://github.com/indexmap-rs/indexmap |
| `inout` | `0.1.4` | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `inout` | `0.2.6` | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `intl-memoizer` | `0.5.3` | Apache-2.0 OR MIT | https://github.com/projectfluent/fluent-rs |
| `intl_pluralrules` | `7.0.2` | Apache-2.0/MIT | https://github.com/zbraniecki/pluralrules |
| `io_tee` | `0.1.1` | MIT OR Apache-2.0 | https://github.com/TheOnlyMrCat/io_tee |
| `itoa` | `1.0.19` | MIT OR Apache-2.0 | https://github.com/dtolnay/itoa |
| `js-sys` | `0.3.107` | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys |
| `keccak` | `0.2.2` | Apache-2.0 OR MIT | https://github.com/RustCrypto/sponges |
| `kem` | `0.3.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| `lazy_static` | `1.5.1` | MIT OR Apache-2.0 | https://github.com/rust-lang-nursery/lazy-static.rs |
| `libc` | `0.2.191` | MIT OR Apache-2.0 | https://github.com/rust-lang/libc |
| `linux-raw-sys` | `0.12.1` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/sunfishcode/linux-raw-sys |
| `lock_api` | `0.4.14` | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| `log` | `0.4.35` | MIT OR Apache-2.0 | https://github.com/rust-lang/log |
| `md5` | `0.8.1` | Apache-2.0 OR MIT | https://github.com/stainless-steel/md5 |
| `memchr` | `2.8.3` | Unlicense OR MIT | https://github.com/BurntSushi/memchr |
| `mime` | `0.3.18` | MIT OR Apache-2.0 | https://github.com/hyperium/mime |
| `mime_guess` | `2.0.5` | MIT | https://github.com/abonander/mime_guess |
| `minimal-lexical` | `0.2.1` | MIT/Apache-2.0 | https://github.com/Alexhuszagh/minimal-lexical |
| `mio` | `1.2.4` | MIT | https://github.com/tokio-rs/mio |
| `ml-kem` | `0.3.4` | Apache-2.0 OR MIT | https://github.com/RustCrypto/KEMs |
| `module-lattice` | `0.2.4` | Apache-2.0 OR MIT | https://github.com/RustCrypto/KEMs |
| `nix` | `0.31.3` | MIT | https://github.com/nix-rust/nix |
| `nom` | `7.1.3` | MIT | https://github.com/Geal/nom |
| `num-bigint` | `0.5.1` | MIT OR Apache-2.0 | https://github.com/rust-num/num-bigint |
| `num-integer` | `0.1.47` | MIT OR Apache-2.0 | https://github.com/rust-num/num-integer |
| `num-traits` | `0.2.19` | MIT OR Apache-2.0 | https://github.com/rust-num/num-traits |
| `once_cell` | `1.21.4` | MIT OR Apache-2.0 | https://github.com/matklad/once_cell |
| `opaque-debug` | `0.3.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `p256` | `0.14.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| `p384` | `0.14.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| `p521` | `0.14.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| `pageant` | `0.2.5` | Apache-2.0 | https://github.com/warp-tech/russh |
| `parking_lot` | `0.12.5` | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| `parking_lot_core` | `0.9.12` | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| `password-hash` | `0.6.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `pbkdf2` | `0.12.2` | MIT OR Apache-2.0 | https://github.com/RustCrypto/password-hashes/tree/master/pbkdf2 |
| `pbkdf2` | `0.13.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/password-hashes |
| `pem-rfc7468` | `1.0.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `percent-encoding` | `2.3.2` | MIT OR Apache-2.0 | https://github.com/servo/rust-url/ |
| `phc` | `0.6.1` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `pin-project` | `1.1.13` | Apache-2.0 OR MIT | https://github.com/taiki-e/pin-project |
| `pin-project-internal` | `1.1.13` | Apache-2.0 OR MIT | https://github.com/taiki-e/pin-project |
| `pin-project-lite` | `0.2.17` | Apache-2.0 OR MIT | https://github.com/taiki-e/pin-project-lite |
| `pkcs1` | `0.8.0-rc.4` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `pkcs5` | `0.8.1` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `pkcs8` | `0.11.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `plain` | `0.2.3` | MIT/Apache-2.0 | https://github.com/randomites/plain |
| `poly1305` | `0.8.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| `poly1305` | `0.9.1` | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| `polyval` | `0.7.3` | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| `ppv-lite86` | `0.2.21` | MIT OR Apache-2.0 | https://github.com/cryptocorrosion/cryptocorrosion |
| `primefield` | `0.14.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| `primeorder` | `0.14.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| `proc-macro-error-attr2` | `2.0.0` | MIT OR Apache-2.0 | https://github.com/GnomedDev/proc-macro-error-2 |
| `proc-macro-error2` | `2.0.1` | MIT OR Apache-2.0 | https://github.com/GnomedDev/proc-macro-error-2 |
| `proc-macro2` | `1.0.107` | MIT OR Apache-2.0 | https://github.com/dtolnay/proc-macro2 |
| `quote` | `1.0.47` | MIT OR Apache-2.0 | https://github.com/dtolnay/quote |
| `r-efi` | `6.0.0` | MIT OR Apache-2.0 OR LGPL-2.1-or-later | https://github.com/r-efi/r-efi |
| `rand` | `0.10.3` | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| `rand` | `0.8.8` | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| `rand_chacha` | `0.3.1` | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| `rand_core` | `0.10.1` | MIT OR Apache-2.0 | https://github.com/rust-random/rand_core |
| `rand_core` | `0.6.4` | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| `redox_syscall` | `0.5.18` | MIT | https://gitlab.redox-os.org/redox-os/syscall |
| `rfc6979` | `0.6.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures |
| `ring` | `0.17.14` | Apache-2.0 AND ISC | https://github.com/briansmith/ring |
| `rsa` | `0.10.0-rc.18` | MIT OR Apache-2.0 | https://github.com/RustCrypto/RSA |
| `russh` | `0.65.1` | Apache-2.0 | https://github.com/warp-tech/russh |
| `russh-cryptovec` | `0.62.0` | Apache-2.0 | https://github.com/warp-tech/russh |
| `russh-sftp` | `3.0.1` | Apache-2.0 | https://github.com/AspectUnk/russh-sftp |
| `russh-util` | `0.52.0` | Apache-2.0 | https://github.com/warp-tech/russh |
| `rust-embed` | `8.14.0` | MIT | https://pyrossh.dev/repos/rust-embed |
| `rust-embed-impl` | `8.14.0` | MIT | https://pyrossh.dev/repos/rust-embed |
| `rust-embed-utils` | `8.14.0` | MIT | https://pyrossh.dev/repos/rust-embed |
| `rustc-hash` | `1.1.0` | Apache-2.0/MIT | https://github.com/rust-lang-nursery/rustc-hash |
| `rustc-hash` | `2.1.3` | Apache-2.0 OR MIT | https://github.com/rust-lang/rustc-hash |
| `rustix` | `1.1.6` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/rustix |
| `rustversion` | `1.0.23` | MIT OR Apache-2.0 | https://github.com/dtolnay/rustversion |
| `salsa20` | `0.10.2` | MIT OR Apache-2.0 | https://github.com/RustCrypto/stream-ciphers |
| `salsa20` | `0.11.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/stream-ciphers |
| `same-file` | `1.0.6` | Unlicense/MIT | https://github.com/BurntSushi/same-file |
| `scopeguard` | `1.2.0` | MIT OR Apache-2.0 | https://github.com/bluss/scopeguard |
| `scroll` | `0.12.0` | MIT | https://github.com/m4b/scroll |
| `scroll_derive` | `0.12.1` | MIT | https://github.com/m4b/scroll |
| `scrypt` | `0.11.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/password-hashes/tree/master/scrypt |
| `scrypt` | `0.12.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/password-hashes |
| `sec1` | `0.8.1` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `secrecy` | `0.10.3` | Apache-2.0 OR MIT | https://github.com/iqlusioninc/crates/tree/main/secrecy |
| `self_cell` | `0.10.3` | Apache-2.0 | https://github.com/Voultapher/self_cell |
| `self_cell` | `1.3.0` | Apache-2.0 OR GPL-2.0-only | https://github.com/Voultapher/self_cell |
| `serde` | `1.0.229` | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_bytes` | `0.11.19` | MIT OR Apache-2.0 | https://github.com/serde-rs/bytes |
| `serde_core` | `1.0.229` | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_derive` | `1.0.229` | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_json` | `1.0.154` | MIT OR Apache-2.0 | https://github.com/serde-rs/json |
| `serde_spanned` | `1.1.3` | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `serdect` | `0.4.3` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `sha1` | `0.11.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| `sha2` | `0.10.9` | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| `sha2` | `0.11.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| `sha3` | `0.12.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| `shake` | `0.1.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/XOFs |
| `signature` | `3.0.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| `siphasher` | `1.0.4` | MIT OR Apache-2.0 | https://github.com/jedisct1/rust-siphash |
| `slab` | `0.4.12` | MIT | https://github.com/tokio-rs/slab |
| `smallvec` | `1.16.5` | MIT OR Apache-2.0 | https://github.com/servo/rust-smallvec |
| `smawk` | `0.3.3` | MIT | https://github.com/mgeisler/smawk |
| `socket2` | `0.6.5` | MIT OR Apache-2.0 | https://github.com/rust-lang/socket2 |
| `spki` | `0.8.1` | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `sponge-cursor` | `0.1.0` | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `ssh-cipher` | `0.3.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/SSH |
| `ssh-encoding` | `0.3.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/SSH |
| `ssh-key` | `0.7.0-rc.11` | Apache-2.0 OR MIT | https://github.com/RustCrypto/SSH |
| `static_assertions` | `1.1.0` | MIT OR Apache-2.0 | https://github.com/nvzqz/static-assertions-rs |
| `strsim` | `0.11.1` | MIT | https://github.com/rapidfuzz/strsim-rs |
| `subtle` | `2.6.1` | BSD-3-Clause | https://github.com/dalek-cryptography/subtle |
| `syn` | `2.0.119` | MIT OR Apache-2.0 | https://github.com/dtolnay/syn |
| `syn` | `3.0.10` | MIT OR Apache-2.0 | https://github.com/dtolnay/syn |
| `tempfile` | `3.27.0` | MIT OR Apache-2.0 | https://github.com/Stebalien/tempfile |
| `textwrap` | `0.16.4` | MIT | https://github.com/mgeisler/textwrap |
| `thiserror` | `1.0.69` | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| `thiserror` | `2.0.21` | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| `thiserror-impl` | `1.0.69` | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| `thiserror-impl` | `2.0.21` | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| `tinystr` | `0.8.5` | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `tokio` | `1.54.1` | MIT | https://github.com/tokio-rs/tokio |
| `tokio-macros` | `2.7.2` | MIT | https://github.com/tokio-rs/tokio |
| `tokio-util` | `0.7.20` | MIT | https://github.com/tokio-rs/tokio |
| `toml` | `0.5.11` | MIT/Apache-2.0 | https://github.com/toml-rs/toml |
| `toml` | `1.2.1+spec-1.1.0` | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `toml_datetime` | `1.1.3+spec-1.1.0` | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `toml_parser` | `1.1.5+spec-1.1.0` | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `toml_writer` | `1.2.0+spec-1.1.0` | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `type-map` | `0.5.1` | MIT/Apache-2.0 | https://github.com/kardeiz/type-map |
| `typenum` | `1.20.1` | MIT OR Apache-2.0 | https://github.com/paholg/typenum |
| `unic-langid` | `0.9.6` | MIT OR Apache-2.0 | https://github.com/zbraniecki/unic-locale |
| `unic-langid-impl` | `0.9.6` | MIT OR Apache-2.0 | https://github.com/zbraniecki/unic-locale |
| `unicase` | `2.10.0` | MIT OR Apache-2.0 | https://github.com/seanmonstar/unicase |
| `unicode-ident` | `1.0.27` | (MIT OR Apache-2.0) AND Unicode-3.0 | https://github.com/dtolnay/unicode-ident |
| `unicode-width` | `0.2.3` | MIT OR Apache-2.0 | https://github.com/unicode-rs/unicode-width |
| `uniffi` | `0.32.2` | MPL-2.0 | https://github.com/mozilla/uniffi-rs |
| `uniffi_bindgen` | `0.32.2` | MPL-2.0 | https://github.com/mozilla/uniffi-rs |
| `uniffi_core` | `0.32.2` | MPL-2.0 | https://github.com/mozilla/uniffi-rs |
| `uniffi_internal_macros` | `0.32.2` | MPL-2.0 | https://github.com/mozilla/uniffi-rs |
| `uniffi_macros` | `0.32.2` | MPL-2.0 | https://github.com/mozilla/uniffi-rs |
| `uniffi_meta` | `0.32.2` | MPL-2.0 | https://github.com/mozilla/uniffi-rs |
| `uniffi_pipeline` | `0.32.2` | MPL-2.0 | https://github.com/mozilla/uniffi-rs |
| `uniffi_udl` | `0.32.2` | MPL-2.0 | https://github.com/mozilla/uniffi-rs |
| `universal-hash` | `0.5.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `universal-hash` | `0.6.1` | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `untrusted` | `0.9.0` | ISC | https://github.com/briansmith/untrusted |
| `walkdir` | `2.5.0` | Unlicense/MIT | https://github.com/BurntSushi/walkdir |
| `wasi` | `0.11.1+wasi-snapshot-preview1` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasi |
| `wasm-bindgen` | `0.2.130` | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen |
| `wasm-bindgen-futures` | `0.4.80` | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures |
| `wasm-bindgen-macro` | `0.2.130` | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro |
| `wasm-bindgen-macro-support` | `0.2.130` | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/main/crates/macro-support |
| `wasm-bindgen-shared` | `0.2.130` | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared |
| `weedle2` | `5.0.0` | MIT | https://github.com/mozilla/uniffi-rs |
| `winapi-util` | `0.1.11` | Unlicense OR MIT | https://github.com/BurntSushi/winapi-util |
| `windows` | `0.62.2` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-collections` | `0.3.2` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-core` | `0.62.2` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-future` | `0.3.2` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-implement` | `0.60.2` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-interface` | `0.59.3` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-link` | `0.2.1` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-numerics` | `0.3.1` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-result` | `0.4.1` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-strings` | `0.5.1` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-sys` | `0.52.0` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-sys` | `0.61.2` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-targets` | `0.52.6` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows-threading` | `0.2.1` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows_aarch64_gnullvm` | `0.52.6` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows_aarch64_msvc` | `0.52.6` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows_i686_gnu` | `0.52.6` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows_i686_gnullvm` | `0.52.6` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows_i686_msvc` | `0.52.6` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows_x86_64_gnu` | `0.52.6` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows_x86_64_gnullvm` | `0.52.6` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `windows_x86_64_msvc` | `0.52.6` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `winnow` | `1.0.5` | MIT | https://github.com/winnow-rs/winnow |
| `wnaf` | `0.14.1` | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| `x25519-dalek` | `2.0.1` | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/x25519-dalek |
| `zerocopy` | `0.8.63` | BSD-2-Clause OR Apache-2.0 OR MIT | https://github.com/google/zerocopy |
| `zerocopy-derive` | `0.8.63` | BSD-2-Clause OR Apache-2.0 OR MIT | https://github.com/google/zerocopy |
| `zerofrom` | `0.1.8` | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zeroize` | `1.9.1` | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| `zeroize_derive` | `1.5.0` | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| `zerovec` | `0.11.9` | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zmij` | `1.0.23` | MIT | https://github.com/dtolnay/zmij |
