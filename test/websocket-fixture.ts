/** A minimal WebSocket server side for fixture proxies in tests. */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/** A minimal WebSocket server side (RFC 6455): text messages in, text messages out, close and ping answered. */
export function acceptWebSocket(
	req: IncomingMessage,
	socket: Socket,
	onMessage: (send: (text: string) => void, text: string) => void,
) {
	const accept = createHash("sha1")
		.update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
		.digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	const frame = (opcode: number, payload: Buffer) => {
		const length = payload.length;
		const head =
			length < 126
				? Buffer.from([0x80 | opcode, length])
				: Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
		if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
	};
	const send = (text: string) => frame(0x1, Buffer.from(text));
	let buffered = Buffer.alloc(0);
	socket.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		while (buffered.length >= 2) {
			const opcode = buffered[0]! & 0x0f;
			let length = buffered[1]! & 0x7f;
			let offset = 2;
			if (length === 126) {
				length = buffered.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				length = Number(buffered.readBigUInt64BE(2));
				offset = 10;
			}
			if (buffered.length < offset + 4 + length) return;
			const mask = buffered.subarray(offset, offset + 4);
			const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
			for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
			buffered = buffered.subarray(offset + 4 + length);
			if (opcode === 0x1) onMessage(send, payload.toString("utf8"));
			else if (opcode === 0x9) frame(0xa, payload);
			else if (opcode === 0x8) {
				frame(0x8, Buffer.alloc(0));
				socket.end();
			}
		}
	});
	socket.on("error", () => {});
}
