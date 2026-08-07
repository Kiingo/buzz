use std::io::{Read as _, Write as _};

#[tokio::test]
async fn html_payload_too_large_response_preserves_actionable_status() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let body = "<html><body>request too large</body></html>";
            let response = format!(
                "HTTP/1.1 413 Payload Too Large\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });

    let response = reqwest::Client::new()
        .get(format!("http://{addr}/"))
        .send()
        .await
        .expect("request must succeed");

    assert_eq!(
        super::relay_error_message(response).await,
        "relay returned 413 Payload Too Large"
    );
}
