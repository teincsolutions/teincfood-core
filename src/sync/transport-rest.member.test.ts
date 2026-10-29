import { describe, expect, it, vi, beforeEach } from "vitest";
import { restTransport } from "./transport-rest";
import { businessService } from "../adapters/services";
import type { Command } from "./types";

function command(overrides: Partial<Command>): Command {
  return {
    command_id: "cmd-1",
    command_type: "member:invite",
    command_version: "1.0",
    timestamp: "2026-10-29T12:00:00.000Z",
    device_id: "device-1",
    user_id: "user-1",
    business_id: "biz-1",
    payload: {},
    ...overrides,
  };
}

describe("RestTransport member commands", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("dispatches invite and returns a member.invited event", async () => {
    const invite = vi
      .spyOn(businessService, "inviteBusinessMember")
      .mockResolvedValue({ data: { id: "invite-1", status: "pending" } });

    const events = await restTransport.execute(
      command({ payload: { email: "ama@example.com", role: "sales" } }),
    );

    expect(invite).toHaveBeenCalledWith("biz-1", {
      email: "ama@example.com",
      role: "sales",
    });
    expect(events[0]?.event_type).toBe("member.invited");
    expect(events[0]?.entity_id).toBe("invite-1");
  });

  it("dispatches role updates and removals by user id", async () => {
    const update = vi
      .spyOn(businessService, "updateBusinessMember")
      .mockResolvedValue({ data: { id: "member-1", role: "manager" } });
    const remove = vi.spyOn(businessService, "removeBusinessMember").mockResolvedValue(undefined);

    const updated = await restTransport.execute(
      command({
        command_id: "cmd-2",
        command_type: "member:update",
        entity_id: "user-2",
        payload: { role: "manager" },
      }),
    );
    const removed = await restTransport.execute(
      command({
        command_id: "cmd-3",
        command_type: "member:remove",
        entity_id: "user-2",
        payload: {},
      }),
    );

    expect(update).toHaveBeenCalledWith("biz-1", "user-2", { role: "manager" });
    expect(remove).toHaveBeenCalledWith("biz-1", "user-2");
    expect(updated[0]?.event_type).toBe("member.updated");
    expect(removed[0]?.event_type).toBe("member.removed");
  });
});
