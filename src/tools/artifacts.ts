import { z } from "zod";
import { defineTool } from "./types.js";

export const readArtifactTool = defineTool({
  name: "read_artifact",
  description: "Read a bounded slice of a full tool-output artifact by ID.",
  schema: z.object({
    artifact_id: z.string().regex(/^artifact_[a-f0-9]{16}$/),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(30_000).default(20_000),
  }),
  readOnly: true,
  async execute(context, input) {
    return { content: await context.artifacts.read(input.artifact_id, input.offset, input.limit) };
  },
});
