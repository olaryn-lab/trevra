import { describe, it, expect } from 'vitest';
import { workflowStepsSchema } from '../server/linkedin/workflows.js';
import { ADDITIONAL_WORKFLOW_STARTERS } from './workflow-starter-recipes.js';

describe('Dripify-parity managed workflow starter recipes', () => {
  it('adds fourteen distinct objectives to the four existing manager starters', () => {
    expect(ADDITIONAL_WORKFLOW_STARTERS).toHaveLength(14);
    const names = ADDITIONAL_WORKFLOW_STARTERS.map((item) => item.label);
    const ids = ADDITIONAL_WORKFLOW_STARTERS.map((item) => item.key);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(names.every((name) => name.trim().length > 4)).toBe(true);
  });

  it('creates server-valid, unique and deterministic workflow graphs for all fourteen recipes', () => {
    for (const recipe of ADDITIONAL_WORKFLOW_STARTERS) {
      let serial = 0;
      const steps = recipe.build(() => `step-${++serial}`);
      expect(steps.length, recipe.key).toBeGreaterThanOrEqual(2);
      expect(new Set(steps.map((item) => item.id)).size, recipe.key).toBe(steps.length);
      expect(() => workflowStepsSchema.parse(steps), recipe.key).not.toThrow();
      let other = 0;
      expect(
        recipe.build(() => `step-${++other}`),
        recipe.key
      ).toEqual(steps);
    }
  });

  it('guards every LinkedIn message behind accepted/connected status', () => {
    for (const recipe of ADDITIONAL_WORKFLOW_STARTERS) {
      let serial = 0;
      const steps = recipe.build(() => `step-${++serial}`);
      const messages = steps.filter((step) => step.action === 'message');
      for (const message of messages) {
        if (message.action !== 'message') continue;
        expect(message.config.requiresAcceptedConnection, recipe.key).toBe(
          steps.some((step) => step.action === 'connection_request')
        );
      }
      if (messages.length > 0)
        expect(
          steps.some(
            (step) => step.action === 'monitor' && step.config.condition.kind === 'accepted'
          ) ||
            steps.some(
              (step) => step.action === 'condition' && step.config.condition.kind === 'connected'
            ),
          recipe.key
        ).toBe(true);
    }
  });

  it('defaults to no-note invites, untracked email and no automatic paid InMail', () => {
    for (const recipe of ADDITIONAL_WORKFLOW_STARTERS) {
      let serial = 0;
      const steps = recipe.build(() => `step-${++serial}`);
      for (const step of steps) {
        if (step.action === 'connection_request') expect(step.config.message, recipe.key).toBe('');
        if (step.action === 'email') {
          expect(step.config.tracking, recipe.key).toBe('off');
          expect(step.config.variants[0]?.body.length, recipe.key).toBeGreaterThan(10);
        }
        if (step.action === 'inmail') expect(step.config.allowPaid, recipe.key).toBe(false);
      }
    }
  });
});
