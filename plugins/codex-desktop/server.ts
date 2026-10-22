import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { codexDesktopContract, openThreadInputSchema, type ListThreadsResult, type OpenThreadResult, type Unavailable } from "./contract.js";

const HELP = "bb codex-desktop chats\nbb codex-desktop open <codex_desktop_thread_uuid>\nLists saved Personal OS observations. Open explicitly requests navigation on the configured Mac; it does not create or message chats.";

function unavailable(reason: Unavailable["reason"]): Unavailable {
  return { state: "unavailable", observedAt: new Date().toISOString(), reason };
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hostId: {
      type: "string",
      label: "Codex Desktop Mac host ID",
      description: "Exact enrolled BB host ID of the Mac running Codex Desktop and Personal OS on loopback port 7317. Open acts on that Mac, including requests from mobile.",
      experimental_schema: z.string().min(1).max(200).refine(value => value === value.trim()),
    },
  });
  const host = bb.hosts.experimental_client({ contract: codexDesktopContract });

  const handlers: PluginRpcHandlers<typeof codexDesktopContract> = {
    async listThreads() {
      const current = await settings.get();
      if (!current.hostId) return unavailable("host_not_configured");
      try {
        return await host.call("listThreads", null, { hostId: current.hostId, timeoutMs: 12000 });
      } catch {
        return unavailable("host_unavailable");
      }
    },
    async openThread(input) {
      const current = await settings.get();
      if (!current.hostId) return unavailable("host_not_configured");
      if (input.expectedHostId !== undefined && input.expectedHostId !== current.hostId) return unavailable("host_changed");
      try {
        return await host.call("openThread", { threadId: input.threadId }, { hostId: current.hostId, timeoutMs: 15000 });
      } catch {
        return unavailable("open_outcome_unknown");
      }
    },
  };
  bb.rpc.register(codexDesktopContract, handlers);
  bb.cli.register({
    name: "codex-desktop",
    summary: "List observed Codex Desktop chats and explicitly open a known local chat",
    commands: [
      { name: "chats", summary: "List observed local Codex Desktop chats", usage: "bb codex-desktop chats" },
      { name: "open", summary: "Request opening a known chat on the configured Mac", usage: "bb codex-desktop open <codex_desktop_thread_uuid>" },
    ],
    async run(argv) {
      if (argv.length === 0 || (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0]))) return { exitCode: 0, stdout: HELP };
      let result: ListThreadsResult | OpenThreadResult;
      if (argv[0] === "chats" && argv.length === 1) {
        result = await handlers.listThreads(null);
      } else if (argv[0] === "open" && argv.length === 2) {
        const input = openThreadInputSchema.safeParse({ threadId: argv[1] });
        if (!input.success) return { exitCode: 1, stderr: "Expected a Codex Desktop thread UUID. BB and provider thread IDs are not accepted by inference.\n" + HELP };
        result = await handlers.openThread(input.data);
      } else {
        return { exitCode: 1, stderr: "Unknown command or arguments.\n" + HELP };
      }
      return { exitCode: result.state === "unavailable" ? 2 : 0, stdout: JSON.stringify(result, null, 2) };
    },
  });
}
