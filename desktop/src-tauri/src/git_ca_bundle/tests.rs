use super::{
    apply_relay_git_ca_info, curated_bundle_pem, names_distrusted_ca, operator_ca_configured,
    write_bundle,
};
use rustls::pki_types::{pem::PemObject, CertificateDer};

const AAA_CERTIFICATE_SERVICES: &str = include_str!("fixtures/aaa-certificate-services.pem");
const EMSIGN_ECC_ROOT_CA_G3: &str = include_str!("fixtures/emsign-ecc-root-ca-g3.pem");
const OPERATOR_APPENDED_CA: &str = include_str!("fixtures/operator-appended-ca.pem");

fn subjects(pem: &str) -> Vec<String> {
    CertificateDer::pem_slice_iter(pem.as_bytes())
        .map(|cert| {
            let cert = cert.expect("curated bundle parses");
            let anchor = webpki::anchor_from_trusted_cert(&cert).expect("trust anchor");
            String::from_utf8_lossy(anchor.subject.as_ref()).into_owned()
        })
        .collect()
}

fn mozilla_pem() -> String {
    let mut pem = String::new();
    for cert in webpki_root_certs::TLS_SERVER_ROOT_CERTS {
        super::push_pem(&mut pem, cert.as_ref());
    }
    pem
}

fn has(subjects: &[String], name: &str) -> bool {
    subjects.iter().any(|subject| subject.contains(name))
}

#[test]
fn curated_bundle_drops_emsign_and_aaa_and_keeps_relay_and_github_roots() {
    let system = format!(
        "{}{AAA_CERTIFICATE_SERVICES}{EMSIGN_ECC_ROOT_CA_G3}",
        mozilla_pem()
    );
    let input = subjects(&system);
    assert!(has(&input, "AAA Certificate Services"));
    assert!(has(&input, "emSign ECC Root CA - G3"));

    let curated = subjects(&curated_bundle_pem(Some(system.as_bytes())));
    assert!(curated
        .iter()
        .all(|subject| !names_distrusted_ca(subject.as_bytes())));
    let dropped = input.len() - curated.len();
    let distrusted_in_input = input
        .iter()
        .filter(|subject| names_distrusted_ca(subject.as_bytes()))
        .count();
    assert_eq!(dropped, distrusted_in_input);
    assert!(dropped >= 2, "both fixtures are dropped");
    // A DigiCert-issued relay host chains to DigiCert Global Root G2; github.com to
    // Sectigo Public Server Authentication Root E46 / USERTrust ECC.
    for root in [
        "DigiCert Global Root G2",
        "Sectigo Public Server Authentication Root E46",
        "USERTrust ECC Certification Authority",
        "Microsoft RSA Root Certificate Authority 2017",
    ] {
        assert!(has(&curated, root), "{root} must stay trusted");
    }
}

#[test]
fn curated_bundle_keeps_a_ca_the_operator_appended_to_the_system_bundle() {
    let system = format!(
        "{}{OPERATOR_APPENDED_CA}{AAA_CERTIFICATE_SERVICES}",
        mozilla_pem()
    );
    let curated = subjects(&curated_bundle_pem(Some(system.as_bytes())));
    assert!(has(&curated, "Example Corp TLS Inspection Root"));
    assert!(!has(&curated, "AAA Certificate Services"));
}

#[test]
fn curated_bundle_falls_back_to_mozilla_roots_without_a_usable_system_bundle() {
    let fallback = subjects(&curated_bundle_pem(None));
    assert!(has(&fallback, "DigiCert Global Root G2"));
    assert!(fallback
        .iter()
        .all(|subject| !names_distrusted_ca(subject.as_bytes())));
    assert_eq!(
        subjects(&curated_bundle_pem(Some(b"not a certificate bundle"))),
        fallback
    );
    // A system bundle holding only distrusted roots also falls back.
    let only_distrusted = format!("{AAA_CERTIFICATE_SERVICES}{EMSIGN_ECC_ROOT_CA_G3}");
    assert_eq!(
        subjects(&curated_bundle_pem(Some(only_distrusted.as_bytes()))),
        fallback
    );
}

#[test]
fn bundle_file_is_content_addressed_and_reused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pem = curated_bundle_pem(None);
    let first = write_bundle(dir.path(), &pem).expect("write bundle");
    let second = write_bundle(dir.path(), &pem).expect("reuse bundle");
    assert_eq!(first, second);
    assert_eq!(std::fs::read_to_string(&first).expect("read"), pem);
    let other = write_bundle(dir.path(), OPERATOR_APPENDED_CA).expect("write other");
    assert_ne!(first, other);
}

#[test]
fn operator_ca_environment_wins() {
    assert!(!operator_ca_configured(|_| None));
    assert!(operator_ca_configured(
        |name| (name == "GIT_SSL_CAINFO").then(|| "/corp/ca.pem".into())
    ));
    assert!(operator_ca_configured(
        |name| (name == "GIT_SSL_CAPATH").then(|| "/corp/certs".into())
    ));
    assert!(!operator_ca_configured(|_| Some("".into())));
}

#[test]
fn relay_git_ca_info_appends_after_staged_git_config() {
    let bundle = std::path::Path::new("/tmp/git-ca-test.pem");
    let mut command = std::process::Command::new("custom-acp");
    command.env("GIT_CONFIG_COUNT", "2");
    apply_relay_git_ca_info(&mut command, "https://relay.example", Some(bundle));
    let env: std::collections::HashMap<_, _> = command
        .get_envs()
        .filter_map(|(key, value)| Some((key.to_str()?, value?.to_str()?)))
        .collect();
    assert_eq!(env.get("GIT_CONFIG_COUNT"), Some(&"3"));
    assert_eq!(
        env.get("GIT_CONFIG_KEY_2"),
        Some(&"http.https://relay.example/git.sslCAInfo")
    );
    assert_eq!(env.get("GIT_CONFIG_VALUE_2"), Some(&"/tmp/git-ca-test.pem"));

    let mut untouched = std::process::Command::new("buzz-acp");
    apply_relay_git_ca_info(&mut untouched, "https://relay.example", None);
    assert_eq!(untouched.get_envs().count(), 0);
}
