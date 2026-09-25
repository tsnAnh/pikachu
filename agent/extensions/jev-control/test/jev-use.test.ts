import assert from "node:assert/strict";
import test from "node:test";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { chooseBoundedAction, validateChoiceRequest, type JevChoiceRequest } from "../src/jev-use.js";

const request: JevChoiceRequest = {
  goal: "Enter the sample value, then submit the local form",
  observation: "Fresh form snapshot: input is empty and Submit is enabled",
  captureId: "capture-1",
  history: ["Opened the local test form"],
  candidates: [
    { id: "type_value", description: "Type the sample value into the visible input" },
    { id: "reobserve", description: "Get a fresh page snapshot" },
    { id: "abstain", description: "Stop without changing the page" },
  ],
};

function clientChoice(selectedId: string, confidence: number): Pick<TypeSafeClient, "systemOne"> {
  return {
    async systemOne() {
      return {
        answers: {
          driver_action: {
            type: "choice",
            choice: selectedId,
            confidence,
            probabilities: { [selectedId]: confidence },
          },
        },
        model: "jev-test",
      };
    },
  } as unknown as Pick<TypeSafeClient, "systemOne">;
}

test("bounded Jev choice admits only supplied IDs and abstains below confidence policy", async () => {
  const selected = await chooseBoundedAction(clientChoice("type_value", 0.91), request);
  assert.equal(selected.selectedId, "type_value");
  assert.equal(selected.abstained, false);
  const uncertain = await chooseBoundedAction(clientChoice("type_value", 0.4), request);
  assert.equal(uncertain.selectedId, "abstain");
  assert.equal(uncertain.abstained, true);
  await assert.rejects(chooseBoundedAction(clientChoice("unlisted", 0.95), request), /unknown candidate/);
});

test("choice request rejects ambiguous candidates and screenshot bytes before provider use", () => {
  assert.throws(() => validateChoiceRequest({
    ...request,
    candidates: [request.candidates[0], request.candidates[0], request.candidates[2]],
  }), /unique/);
  assert.throws(() => validateChoiceRequest({
    ...request,
    candidates: request.candidates.filter((candidate) => candidate.id !== "abstain"),
  }), /reobserve and abstain/);
  assert.throws(() => validateChoiceRequest({ ...request, observation: "data:image/png;base64,secret" }), /screenshot bytes/);
});
