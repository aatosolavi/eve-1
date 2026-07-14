---
"eve": patch
---

Replace `eve dev` workers gracefully: the retired worker keeps serving the responses and sockets it already admitted while new requests go to the ready replacement, a failed replacement leaves the previous worker serving, and shutdown stays bounded with streams open.
