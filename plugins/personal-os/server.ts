import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { missionInputSchema, personalOsContract, type MissionResult, type MissionsResult, type TasksResult } from "./contract.js";

const HELP = "bb personal-os missions\nbb personal-os mission <mission_id>\nbb personal-os tasks <mission_id>\nRead-only JSON. Configure the enrolled host ID with bb plugin config personal-os.";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hostId: {
      type: "string",
      label: "Personal OS host ID",
      description: "Exact enrolled BB host ID of the Mac running Personal OS on loopback port 7317.",
      experimental_schema: z.string().min(1).max(200).refine(value => value === value.trim()),
    },
  });
  const host = bb.hosts.experimental_client({ contract: personalOsContract });

  async function hostCall<T>(call: (hostId: string) => Promise<T>) {
    const current = await settings.get();
    if (!current.hostId) return { state: "unavailable" as const, observedAt: new Date().toISOString(), reason: "host_not_configured" as const };
    try {
      return await call(current.hostId);
    } catch {
      return { state: "unavailable" as const, observedAt: new Date().toISOString(), reason: "host_unavailable" as const };
    }
  }

  const handlers: PluginRpcHandlers<typeof personalOsContract> = {
    listMissions: () => hostCall(hostId => host.call("listMissions", null, { hostId, timeoutMs: 10000 })),
    getMission: input => hostCall(hostId => host.call("getMission", input, { hostId, timeoutMs: 10000 })),
    listTasks: input => hostCall(hostId => host.call("listTasks", input, { hostId, timeoutMs: 10000 })),
  };
  bb.rpc.register(personalOsContract, handlers);
  bb.cli.register({
    name: "personal-os",
    summary: "Read Personal OS goals and tasks from its enrolled host",
    commands: [
      { name: "missions", summary: "List goals", usage: "bb personal-os missions" },
      { name: "mission", summary: "Read one goal", usage: "bb personal-os mission <mission_id>" },
      { name: "tasks", summary: "Read goal tasks", usage: "bb personal-os tasks <mission_id>" },
    ],
    async run(argv) {
      if (argv.length === 0 || (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0]))) return { exitCode: 0, stdout: HELP };
      let result: MissionsResult | MissionResult | TasksResult;
      if (argv[0] === "missions" && argv.length === 1) {
        result = await handlers.listMissions(null);
      } else if ((argv[0] === "mission" || argv[0] === "tasks") && argv.length === 2) {
        const input = missionInputSchema.safeParse({ missionId: argv[1] });
        if (!input.success) return { exitCode: 1, stderr: "Invalid mission ID.\n" + HELP };
        result = argv[0] === "mission" ? await handlers.getMission(input.data) : await handlers.listTasks(input.data);
      } else {
        return { exitCode: 1, stderr: "Unknown command or arguments.\n" + HELP };
      }
      return { exitCode: result.state === "available" ? 0 : 2, stdout: JSON.stringify(result, null, 2) };
    },
  });
}
