import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { PageSchema } from "../core/page.ts";
import { ConversationSchema } from "./entities.ts";

const label = z.string().trim().min(1).max(200);
const ok = z.strictObject({ ok: z.literal(true) });
const botId = z.strictObject({ botId: IdSchema });
const page = PageSchema;
export const TopicMethods = {
  "topics.metadata": {
    params: botId.extend({ topicId: IdSchema }),
    result: ConversationSchema.pick({ title: true, routineId: true, importSource: true })
      .extend({ readOnly: z.boolean() })
      .nullable(),
  },
  "topics.list": {
    params: botId.extend(page.shape).extend({
      query: z.string().trim().max(200).optional(),
      archived: z.boolean().optional(),
      // Previews follow the newest message; topic activity alone (a routine's new empty topic)
      // bumps updated_at and must not displace it. Cursor order is newest message, then id.
      withMessages: z.boolean().optional(),
      // Opening a Bot needs only its current topic; paging up to 200 rows per call just to find
      // the marker made the sidebar wait on busy brains (maintainers 2026-11-14).
      currentOnly: z.boolean().optional(),
    }),
    result: z
      .array(
        ConversationSchema.extend({
          messageCount: z.number().int().nonnegative(),
          isCurrent: z.boolean(),
          workplaceBusy: z.boolean().optional(),
          // Bound-topic metadata includes hidden/session folders without exposing their paths.
          workplaceFolderName: z.string().max(1000).nullable().optional(),
        }),
      )
      .max(200),
  },
  "topics.rename": {
    params: botId.extend({ topicId: IdSchema, title: label }),
    result: ConversationSchema,
  },
  "topics.archive": { params: botId.extend({ topicId: IdSchema }), result: ok },
  "topics.restore": { params: botId.extend({ topicId: IdSchema }), result: ConversationSchema },
  "topics.create": { params: botId, result: ConversationSchema },
  "topics.switch": { params: botId.extend({ topicId: IdSchema }), result: ConversationSchema },
} as const;
