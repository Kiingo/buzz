//! What the signer will sign. Pure functions, so every rule has a plain test.

/// Kinds with a dedicated op that checks origin or scope. `sign_event` must
/// never sign these, or a child skips those checks: NIP-98 (27235), Blossom
/// (24242) and relay auth (22242).
const RESERVED_KINDS: [u16; 3] = [27235, 24242, 22242];

/// Default deny. Off this list on purpose:
/// - 30174 engrams: they go through `mem_write`, so a child can never wrap
///   chosen ciphertext in an agent-signed engram and turn `mem_read` into a
///   decrypt oracle.
/// - 46030 and 46031 workflow approvals: a child must not approve with an
///   agent key.
/// - 30620 workflow definitions: a schedule would keep firing as the agent
///   after the child is gone, past the stated limit.
const ALLOWED_KINDS: &[(u16, u16)] = &[
    (0, 1),
    (3, 3),
    (5, 5),
    (7, 7),
    (9, 9),
    (1617, 1619),
    (1621, 1621),
    (1630, 1633),
    (9000, 9002),
    (9005, 9005),
    (9007, 9008),
    (9021, 9022),
    (9035, 9036),
    (9040, 9044),
    (10000, 10003),
    (10100, 10100),
    (20001, 20001),
    (24200, 24201),
    (30000, 30000),
    (30003, 30003),
    (30023, 30023),
    (30030, 30030),
    (30315, 30315),
    (30617, 30617),
    (30621, 30621),
    (40003, 40003),
    (40008, 40008),
    (40098, 40098),
    (40100, 40100),
    (41010, 41012),
    (45001, 45003),
    (46020, 46020),
];

/// How far a caller's `created_at` may sit from the signer's clock, either way.
pub(super) const CREATED_AT_WINDOW_SECS: u64 = 60;

pub(super) fn check_kind(kind: u16) -> Result<(), &'static str> {
    if RESERVED_KINDS.contains(&kind) {
        return Err("signer_kind_reserved");
    }
    if ALLOWED_KINDS
        .iter()
        .any(|(first, last)| (*first..=*last).contains(&kind))
    {
        return Ok(());
    }
    Err("signer_kind_not_allowed")
}

/// Kinds 9035 and 9036 carry an owner attestation about the target in their own
/// `auth` tag, so they keep that tag and get no NIP-OA injection.
pub(super) fn carries_target_attestation(kind: u16) -> bool {
    matches!(kind, 9035 | 9036)
}

/// The `created_at` to sign. The signer's clock when the caller gave none.
pub(super) fn created_at(now: u64, requested: Option<u64>) -> Result<u64, &'static str> {
    match requested {
        None => Ok(now),
        Some(value) if value.abs_diff(now) <= CREATED_AT_WINDOW_SECS => Ok(value),
        Some(_) => Err("signer_created_at_out_of_window"),
    }
}

/// A NIP-42 challenge exactly as the relay generates one: 32 bytes, lowercase
/// hex. Anything else isn't a challenge from this relay.
pub(super) fn check_challenge(challenge: &str) -> Result<(), &'static str> {
    if is_lower_hex_64(challenge) {
        Ok(())
    } else {
        Err("signer_challenge_invalid")
    }
}

pub(super) fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(super) fn check_method(method: &str) -> Result<(), &'static str> {
    if matches!(method, "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE") {
        Ok(())
    } else {
        Err("signer_method_invalid")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::Path;

    #[test]
    fn reserved_kinds_stay_out_even_if_someone_adds_them_to_the_list() {
        for kind in [27235, 24242, 22242] {
            assert_eq!(check_kind(kind), Err("signer_kind_reserved"));
            assert!(
                !ALLOWED_KINDS
                    .iter()
                    .any(|(first, last)| (*first..=*last).contains(&kind)),
                "{kind} must not be on the allowlist"
            );
        }
    }

    #[test]
    fn kinds_with_their_own_path_or_no_place_on_a_socket_are_refused() {
        for kind in [30174, 46030, 46031, 30620] {
            assert_eq!(check_kind(kind), Err("signer_kind_not_allowed"), "{kind}");
        }
    }

    #[test]
    fn the_default_is_deny() {
        for kind in [2, 4, 6, 8, 1059, 1984, 9999, 13194, 30000 + 1, 65535] {
            assert_eq!(check_kind(kind), Err("signer_kind_not_allowed"), "{kind}");
        }
    }

    #[test]
    fn workflow_trigger_and_git_status_are_allowed() {
        for kind in [46020, 1630, 1631, 1632, 1633] {
            assert_eq!(check_kind(kind), Ok(()), "{kind}");
        }
    }

    #[test]
    fn created_at_defaults_to_the_signer_clock() {
        assert_eq!(created_at(1000, None), Ok(1000));
    }

    #[test]
    fn created_at_holds_only_inside_the_window() {
        let now = 1_000_000;
        assert_eq!(created_at(now, Some(now - 60)), Ok(now - 60));
        assert_eq!(created_at(now, Some(now + 60)), Ok(now + 60));
        for value in [now - 61, now + 61, 0, u64::MAX] {
            assert_eq!(
                created_at(now, Some(value)),
                Err("signer_created_at_out_of_window"),
                "{value}"
            );
        }
    }

    #[test]
    fn a_challenge_must_look_like_the_relays_own() {
        assert_eq!(check_challenge(&"a1".repeat(32)), Ok(()));
        for bad in [
            String::new(),
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            "g".repeat(64),
            format!("{} ", "a".repeat(63)),
            "wss://example.invalid".to_string(),
        ] {
            assert_eq!(check_challenge(&bad), Err("signer_challenge_invalid"));
        }
    }

    /// The source without its `#[cfg(test)]` items, found by matching braces.
    fn production_part(source: &str) -> String {
        let mut kept = String::new();
        let mut rest = source;
        while let Some(start) = rest.find("#[cfg(test)]") {
            kept.push_str(&rest[..start]);
            let item = &rest[start..];
            let mut depth = 0usize;
            let mut end = item.len();
            for (index, c) in item.char_indices() {
                match c {
                    '{' => depth += 1,
                    '}' if depth <= 1 => {
                        end = index + 1;
                        break;
                    }
                    '}' => depth -= 1,
                    ';' if depth == 0 => {
                        end = index + 1;
                        break;
                    }
                    _ => {}
                }
            }
            rest = &item[end..];
        }
        kept.push_str(rest);
        kept
    }

    fn workspace_file(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    fn collect_rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                collect_rust_files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// `KIND_X` to its number, from `buzz-core`'s `pub const KIND_X: u32 = N;`.
    fn kind_table(crates: &Path) -> BTreeMap<String, u16> {
        let source = workspace_file(&crates.join("buzz-core/src/kind.rs"));
        let mut table = BTreeMap::new();
        for line in source.lines() {
            let Some(rest) = line.trim().strip_prefix("pub const ") else {
                continue;
            };
            let Some((name, value)) = rest.split_once(": u32 = ") else {
                continue;
            };
            if let Ok(value) = value.trim_end_matches(';').replace('_', "").parse::<u16>() {
                table.insert(name.to_string(), value);
            }
        }
        table
    }

    /// Every kind named in an `EventBuilder::new` in these crates. An argument
    /// this can't resolve fails the test, so a new builder has to be classified.
    fn builder_kinds(crates: &Path) -> (BTreeSet<u16>, BTreeSet<String>) {
        let table = kind_table(crates);
        let mut files = Vec::new();
        collect_rust_files(&crates.join("buzz-cli/src"), &mut files);
        collect_rust_files(&crates.join("buzz-sdk/src"), &mut files);
        let mut kinds = BTreeSet::new();
        let mut unresolved = BTreeSet::new();
        for file in files {
            let source = workspace_file(&file);
            for call in production_part(&source).split("EventBuilder::new(").skip(1) {
                let arg: String = call
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .take(120)
                    .collect();
                let arg = arg.split(',').next().unwrap_or_default();
                let name = arg
                    .trim_start_matches("Kind::Custom(")
                    .trim_start_matches("Kind::from(")
                    .trim_start_matches("Kind::from_u16(")
                    .split(" as ")
                    .next()
                    .unwrap_or_default();
                let name = name
                    .split("as")
                    .next()
                    .unwrap_or_default()
                    .trim_end_matches(')')
                    .rsplit("::")
                    .next()
                    .unwrap_or_default();
                if let Some(kind) = table.get(name) {
                    kinds.insert(*kind);
                } else if name == "EventDeletion" {
                    kinds.insert(5);
                } else if name == "HttpAuth" {
                    kinds.insert(27235);
                } else if let Ok(kind) = name.parse::<u16>() {
                    kinds.insert(kind);
                } else {
                    unresolved.insert(format!("{}: {arg}", file.display()));
                }
            }
        }
        (kinds, unresolved)
    }

    #[test]
    fn every_cli_builder_kind_is_classified() {
        let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let (kinds, unresolved) = builder_kinds(&crates);
        // Built through a dedicated op, or deliberately refused on a socket.
        let handled_elsewhere = [27235, 24242, 22242, 30174, 46030, 46031, 30620];
        // Runtime kinds, traced by hand. `Kind::Custom(status.kind())` is
        // 1630-1633 from `GitStatus::kind`. `Kind::Custom(kind)` in social.rs is
        // limited to 10000-10003, 30000 and 30003. `Kind::Custom(kind)` in
        // builders.rs is 46030 or 46031 from `build_workflow_approval`.
        let traced = ["status.kind()", "Kind::Custom(kind", "Kind::from(kind"];
        let unresolved: Vec<_> = unresolved
            .into_iter()
            .filter(|site| !traced.iter().any(|arg| site.contains(arg)))
            .collect();
        assert!(unresolved.is_empty(), "classify these: {unresolved:#?}");
        for kind in kinds {
            if !handled_elsewhere.contains(&kind) {
                assert_eq!(check_kind(kind), Ok(()), "kind {kind} isn't classified");
            }
        }
    }
}
