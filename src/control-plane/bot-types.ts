import type { Selectable } from "kysely";
import type { BotsTable } from "../db/types.js";

export const legacyBotId = "00000000-0000-0000-0000-000000000001";
export type BotRow = Selectable<BotsTable>;
