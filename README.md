# Solo Lane Duel realtime server

Railway에서 이 폴더를 Root Directory로 지정해 배포합니다. 배포 후 생성된 HTTPS 도메인을
`wss://` 주소로 바꾸어 사이트의 `NEXT_PUBLIC_GAME_WS_URL` 환경 변수에 설정합니다.

환경 변수:

- `ALLOWED_ORIGINS=https://solo-lane-duel.prime-clock-7617.chatgpt.site`
- `PORT`는 Railway가 자동 설정합니다.

서버는 방 코드, 양방향 입력 중계, 연결 종료 감지와 heartbeat를 담당합니다. 사이트는
WebSocket 주소가 없을 때 기존 HTTP 방 연결로 자동 대체합니다.
