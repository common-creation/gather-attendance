import { Game, type Player } from "@gathertown/gather-game-client";
import dayjs from "dayjs";
import dayjsTz from "dayjs/plugin/timezone";
import dayjsUtc from "dayjs/plugin/utc";
import * as fastq from "fastq";
import type { queueAsPromised } from "fastq";
import { JWT } from "google-auth-library";
import {
	GoogleSpreadsheet,
	type GoogleSpreadsheetCell,
} from "google-spreadsheet";
import WebSocket from "isomorphic-ws";

dayjs.extend(dayjsUtc);
dayjs.extend(dayjsTz);

const {
	GATHER_API_KEY,
	GATHER_SPACE_ID,
	GOOGLE_SPREAD_SHEET_ID,
	GOOGLE_SERVICE_ACCOUNT_EMAIL,
	GOOGLE_PRIVATE_KEY,
} = process.env;

if (
	!GATHER_API_KEY ||
	!GATHER_SPACE_ID ||
	!GOOGLE_SPREAD_SHEET_ID ||
	!GOOGLE_SERVICE_ACCOUNT_EMAIL ||
	!GOOGLE_PRIVATE_KEY
) {
	throw new Error(
		"Missing API_KEY or SPACE_ID or GOOGLE_SPREAD_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY",
	);
}

// biome-ignore lint/suspicious/noExplicitAny: うるせえ！！！！！！！！！！！！！！！！！！！
(global as any).WebSocket = WebSocket;

const waitAsync = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

type SyncTask = {
	uid: string;
};

type AddAttendanceTask = {
	d: dayjs.Dayjs;
	uid: string;
	event: string;
};

const syncPlayerQueue: queueAsPromised<SyncTask> = fastq.promise(syncPlayer, 1);
const addAttendanceQueue: queueAsPromised<AddAttendanceTask> = fastq.promise(
	addAttendance,
	1,
);

const doc = new GoogleSpreadsheet(
	GOOGLE_SPREAD_SHEET_ID,
	new JWT({
		email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
		key: GOOGLE_PRIVATE_KEY,
		scopes: ["https://www.googleapis.com/auth/spreadsheets"],
	}),
);

const gather = new Game(GATHER_SPACE_ID, () =>
	Promise.resolve({ apiKey: GATHER_API_KEY }),
);

gather.subscribeToConnection((connected) => {
	console.debug("connected", connected);
});

gather.subscribeToDisconnection((code, reason) => {
	console.debug("disconnected. trying to reconnect | reason:", code, reason);
	gather.connect();
});

gather.subscribeToEvent("playerJoins", async (event) => {
	const now = dayjs().tz("Asia/Tokyo");

	console.debug("playerJoins", event.playerJoins);
	const uid = gather.getPlayerUidFromEncId(event.playerJoins.encId);
	if (!uid) {
		console.error("No uid found for encId:", event.playerJoins.encId);
		return;
	}
	console.debug("encId:", event.playerJoins.encId, "uid:", uid);

	syncPlayerQueue.push({ uid });
	addAttendanceQueue.push({ d: now, uid, event: "入室" });
});

gather.subscribeToEvent("playerExits", async (event) => {
	const now = dayjs().tz("Asia/Tokyo");

	console.debug("playerExits", event.playerExits);
	const uid = gather.getPlayerUidFromEncId(event.playerExits.encId);
	if (!uid) {
		console.error("No uid found for encId:", event.playerExits.encId);
		return;
	}
	console.debug("encId:", event.playerExits.encId, "uid:", uid);

	addAttendanceQueue.push({ d: now, uid, event: "退室" });
});

gather.connect();

function getPlayer(uid: string) {
	// biome-ignore lint/suspicious/noAsyncPromiseExecutor: だってしょうがないじゃん
	return new Promise<Player>(async (resolve) => {
		let player: Player | undefined;

		do {
			await waitAsync(1000);
			player = gather.getPlayer(uid);
		} while (!player?.name);

		resolve(player);
	});
}

async function syncPlayer(args: SyncTask) {
	console.log("syncPlayer()", { uid: args.uid });

	try {
		const player = await getPlayer(args.uid);
		console.debug("uid:", args.uid, "name:", player.name);

		await doc.loadInfo();
		// biome-ignore lint/complexity/useLiteralKeys: 日本語で直接アクセスするのはキモすぎやろがい
		let userSheet = doc.sheetsByTitle["ユーザーマスタ"];
		if (!userSheet) {
			await doc.addSheet({ title: "ユーザーマスタ" });
			// biome-ignore lint/complexity/useLiteralKeys: 日本語で直接アクセスするのはキモすぎやろがい
			userSheet = doc.sheetsByTitle["ユーザーマスタ"];
		}

		await userSheet.loadCells();

		for (let y = 0; ; y++) {
			const Ax = await userSheet.getCell(y, 0);
			if (Ax.value === player.id) {
				const Bx = await userSheet.getCell(y, 1);
				Bx.value = player.name;
				await Bx.save();
				break;
			}
			if (!Ax.value) {
				Ax.value = player.id;
				const Bx = await userSheet.getCell(y, 1);
				Bx.value = player.name;
				await Promise.all([Ax.save(), Bx.save()]);
				break;
			}
		}
	} catch (e) {
		console.error(e);
	}
}

const cachedNextLogRow: { [key: string]: number } = {};

async function addAttendance(args: AddAttendanceTask) {
	console.log("addAttendance()", { uid: args.uid, event: args.event });

	try {
		await doc.loadInfo();

		const thisMonth = dayjs(args.d).tz("Asia/Tokyo").format("YYYY-MM");
		let thisMonthSheet = doc.sheetsByTitle[thisMonth];
		if (!thisMonthSheet) {
			await doc.addSheet({ title: thisMonth });
			thisMonthSheet = doc.sheetsByTitle[thisMonth];
		}

		await thisMonthSheet.loadCells();

		for (let y = cachedNextLogRow[thisMonth] || 0; ; y++) {
			if (y === 1000) {
			}
			let y1: GoogleSpreadsheetCell;
			try {
				y1 = await thisMonthSheet.getCell(y, 0);
			} catch (e) {
				console.error(e);
				await thisMonthSheet.resize({ rowCount: y + 1000, columnCount: 3 });
				console.log("resize:", y + 1000, 3);
				await thisMonthSheet.loadCells();
				y1 = await thisMonthSheet.getCell(y, 0);
			}
			if (!y1.value) {
				y1.value = args.uid;
				const [y2, y3] = await Promise.all([
					thisMonthSheet.getCell(y, 1),
					thisMonthSheet.getCell(y, 2),
				]);
				y2.value = args.d.format("YYYY/MM/DD HH:mm:ss");
				y3.value = args.event;
				console.log(
					"row:",
					y,
					"data:",
					args.uid,
					args.d.format("YYYY/MM/DD HH:mm:ss"),
					args.event,
				);
				await Promise.all([y1.save(), y2.save(), y3.save()]);

				cachedNextLogRow[thisMonth] = y + 1;
				break;
			}
		}
	} catch (e) {
		console.error(e);
	}
}
