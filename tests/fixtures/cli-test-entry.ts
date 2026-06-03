import { SessionStateStore, type SessionLease } from "../../src/store.js";

if (process.env.ACP_AGENT_GATEWAY_TEST_REMOVE_FAILURE === "1") {
  SessionStateStore.prototype.remove = async function (
    this: SessionStateStore,
    sessionRef: string,
  ): Promise<void> {
    throw new Error("Store.remove() test failure injected");
  };
}

if (process.env.ACP_AGENT_GATEWAY_TEST_RELEASE_LEASE_FAILURE === "1") {
  SessionStateStore.prototype.releaseLease = async function (
    this: SessionStateStore,
    lease: SessionLease,
  ): Promise<void> {
    throw new Error("Store.releaseLease() test failure injected");
  };
}

import("../../src/cli.js");
