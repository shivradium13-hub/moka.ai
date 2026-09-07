import { describe, expect, it } from 'vitest';
import { SystemRole } from '@moka/core';
import {
  DelegationDenial,
  MAX_DELEGATION_DEPTH,
  authorizeDelegation,
  describeChain,
  type DelegationFrame,
} from './delegation.js';
import { customerPrincipal, userPrincipal } from './authorize.js';
import { RiskLevel } from './tool.js';
import type { AgentConfig } from './runtime.js';

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: overrides.id ?? 'parent',
    name: overrides.name ?? 'Parent',
    instructions: '',
    permissionLevel: overrides.permissionLevel ?? RiskLevel.EXECUTE,
    allowlist: overrides.allowlist ?? ['search_knowledge', 'create_project', 'delete_project'],
    enabled: overrides.enabled ?? true,
    maxSteps: overrides.maxSteps ?? 10,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  const parent = (overrides.parent as AgentConfig) ?? agent();
  return {
    parent,
    /*
     * `in` rather than `??`, so a test can pass `delegate: undefined`
     * deliberately to mean "the id resolved to nothing". With `??` the default
     * would silently substitute a real agent and the unknown-agent tests would
     * assert nothing.
     */
    delegate:
      'delegate' in overrides
        ? (overrides.delegate as AgentConfig | undefined)
        : agent({ id: 'child', name: 'Child' }),
    delegateId: (overrides.delegateId as string) ?? 'child',
    stack: (overrides.stack as DelegationFrame[]) ?? [{ agentId: parent.id, agentName: parent.name }],
    principal: (overrides.principal as ReturnType<typeof userPrincipal>) ?? userPrincipal(SystemRole.ADMIN),
    stepsRemaining: (overrides.stepsRemaining as number) ?? 8,
  };
}

/* ========================================================================== */
/* 1. Authority never widens                                                  */
/* ========================================================================== */

describe('a delegate can never exceed its delegator', () => {
  it('intersects the allowlists rather than unioning them', () => {
    /*
     * THE test in this file. A union would let a narrow agent borrow a broad
     * one's reach just by calling it, which is the escalation the whole module
     * exists to prevent.
     */
    const decision = authorizeDelegation(
      request({
        parent: agent({ allowlist: ['search_knowledge', 'create_project'] }),
        delegate: agent({ id: 'child', allowlist: ['create_project', 'delete_project'] }),
      }),
    );

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.effective.allowlist).toEqual(['create_project']);
    // The tool only the delegate had is gone.
    expect(decision.effective.allowlist).not.toContain('delete_project');
    // And so is the tool only the parent had.
    expect(decision.effective.allowlist).not.toContain('search_knowledge');
  });

  it('takes the LOWER of the two risk ceilings, whichever side it is on', () => {
    const parentLower = authorizeDelegation(
      request({
        parent: agent({ permissionLevel: RiskLevel.READ }),
        delegate: agent({ id: 'child', permissionLevel: RiskLevel.EXECUTE }),
      }),
    );
    expect(parentLower.allowed && parentLower.effective.permissionLevel).toBe(RiskLevel.READ);

    const delegateLower = authorizeDelegation(
      request({
        parent: agent({ permissionLevel: RiskLevel.EXECUTE }),
        delegate: agent({ id: 'child', permissionLevel: RiskLevel.READ }),
      }),
    );
    expect(delegateLower.allowed && delegateLower.effective.permissionLevel).toBe(RiskLevel.READ);
  });

  it('exhaustively: the effective ceiling is the minimum for all nine pairs', () => {
    const rank = { [RiskLevel.READ]: 0, [RiskLevel.DRAFT]: 1, [RiskLevel.EXECUTE]: 2 };
    const levels = [RiskLevel.READ, RiskLevel.DRAFT, RiskLevel.EXECUTE];

    for (const parentLevel of levels) {
      for (const delegateLevel of levels) {
        const decision = authorizeDelegation(
          request({
            parent: agent({ permissionLevel: parentLevel }),
            delegate: agent({ id: 'child', permissionLevel: delegateLevel }),
          }),
        );
        const expected = rank[parentLevel] <= rank[delegateLevel] ? parentLevel : delegateLevel;
        expect({ parentLevel, delegateLevel, got: decision.allowed && decision.effective.permissionLevel }).toEqual(
          { parentLevel, delegateLevel, got: expected },
        );
      }
    }
  });

  it('refuses when the two share no tools, rather than running a useless agent', () => {
    const decision = authorizeDelegation(
      request({
        parent: agent({ allowlist: ['search_knowledge'] }),
        delegate: agent({ id: 'child', allowlist: ['delete_project'] }),
      }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe(DelegationDenial.NO_SHARED_TOOLS);
  });

  it('returns a NARROWED config, never the delegate as configured', () => {
    /*
     * Guards against the mistake of returning `allowed: true` and letting the
     * caller use `request.delegate`. The whole narrowing is in the returned
     * object, so it has to be the thing that gets used.
     */
    const delegate = agent({ id: 'child', allowlist: ['create_project', 'delete_project'] });
    const decision = authorizeDelegation(
      request({ parent: agent({ allowlist: ['create_project'] }), delegate }),
    );
    expect(decision.allowed && decision.effective).not.toBe(delegate);
    expect(delegate.allowlist).toHaveLength(2); // the input was not mutated
  });
});

/* ========================================================================== */
/* 2. The budget is shared                                                    */
/* ========================================================================== */

describe('a delegate spends the parent run budget, not a fresh one', () => {
  it("discards the delegate's own maxSteps when it exceeds what is left", () => {
    // The bypass this prevents: a delegate configured with 50 steps inside a
    // parent with 10 would make `maxSteps` bound one agent rather than one run.
    const decision = authorizeDelegation(
      request({ delegate: agent({ id: 'child', maxSteps: 50 }), stepsRemaining: 4 }),
    );
    expect(decision.allowed && decision.effective.maxSteps).toBe(4);
  });

  it('keeps the delegate own limit when it is the smaller of the two', () => {
    const decision = authorizeDelegation(
      request({ delegate: agent({ id: 'child', maxSteps: 2 }), stepsRemaining: 9 }),
    );
    expect(decision.allowed && decision.effective.maxSteps).toBe(2);
  });

  it('refuses when the run has nothing left to lend', () => {
    for (const remaining of [0, -1]) {
      const decision = authorizeDelegation(request({ stepsRemaining: remaining }));
      expect({ remaining, allowed: decision.allowed }).toEqual({ remaining, allowed: false });
    }
  });
});

/* ========================================================================== */
/* 3. Termination                                                             */
/* ========================================================================== */

describe('delegation always terminates', () => {
  it('refuses self-delegation with its own clearer message', () => {
    const parent = agent({ id: 'same' });
    const decision = authorizeDelegation(
      request({ parent, delegate: agent({ id: 'same' }), stack: [{ agentId: 'same', agentName: 'Same' }] }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe(DelegationDenial.SELF);
  });

  it('detects a cycle on the FIRST hop rather than after the depth limit', () => {
    /*
     * A → B → A. Relying on the depth limit to break cycles means every cycle
     * costs the maximum number of model calls before failing, which is a bill
     * rather than a guardrail.
     */
    const decision = authorizeDelegation(
      request({
        parent: agent({ id: 'b', name: 'B' }),
        delegate: agent({ id: 'a', name: 'A' }),
        stack: [
          { agentId: 'a', agentName: 'A' },
          { agentId: 'b', agentName: 'B' },
        ],
      }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe(DelegationDenial.CYCLE);
  });

  it('stops at the depth ceiling', () => {
    const stack = Array.from({ length: MAX_DELEGATION_DEPTH }, (_, i) => ({
      agentId: `a${i}`,
      agentName: `A${i}`,
    }));
    const decision = authorizeDelegation(
      request({ parent: agent({ id: `a${MAX_DELEGATION_DEPTH - 1}` }), stack }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe(DelegationDenial.TOO_DEEP);
  });

  it('permits the last level below the ceiling — the control', () => {
    // A depth check that refused everything would pass the test above while
    // making delegation useless.
    const stack = Array.from({ length: MAX_DELEGATION_DEPTH - 1 }, (_, i) => ({
      agentId: `a${i}`,
      agentName: `A${i}`,
    }));
    const decision = authorizeDelegation(
      request({ parent: agent({ id: `a${MAX_DELEGATION_DEPTH - 2}` }), stack }),
    );
    expect(decision.allowed).toBe(true);
  });
});

/* ========================================================================== */
/* 4. Who may delegate at all                                                 */
/* ========================================================================== */

describe('principals', () => {
  it('refuses a visitor-initiated run outright', () => {
    /*
     * Not because the authority rules would fail — a visitor's delegate would
     * still hold no role — but because delegation multiplies the work one
     * anonymous message can trigger, billed to the organization.
     */
    const decision = authorizeDelegation(request({ principal: customerPrincipal() }));
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe(DelegationDenial.CUSTOMER_MAY_NOT_DELEGATE);
  });

  it('refuses a visitor BEFORE any other check, so nothing leaks by message', () => {
    // A visitor asking to delegate to an agent that does not exist must not be
    // able to tell that apart from one that does.
    const missing = authorizeDelegation(
      request({ principal: customerPrincipal(), delegate: undefined }),
    );
    const present = authorizeDelegation(request({ principal: customerPrincipal() }));
    expect(missing).toEqual(present);
  });

  it('permits every staff role, since the principal is checked per tool later', () => {
    // Delegation itself is not role-gated: `authorizeToolCall` still checks the
    // inherited principal against every tool. Gating here as well would be a
    // second, drifting copy of the same rule.
    for (const role of [SystemRole.VIEWER, SystemRole.MEMBER, SystemRole.ADMIN, SystemRole.OWNER]) {
      const decision = authorizeDelegation(request({ principal: userPrincipal(role) }));
      expect({ role, allowed: decision.allowed }).toEqual({ role, allowed: true });
    }
  });
});

/* ========================================================================== */
/* 5. Existence and state                                                     */
/* ========================================================================== */

describe('the delegate must exist and be enabled', () => {
  it('refuses an unknown agent', () => {
    const decision = authorizeDelegation(request({ delegate: undefined }));
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe(DelegationDenial.UNKNOWN_AGENT);
  });

  it('refuses a disabled agent', () => {
    const decision = authorizeDelegation(
      request({ delegate: agent({ id: 'child', enabled: false }) }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe(DelegationDenial.DELEGATE_DISABLED);
  });

  it('never returns a message naming another agent internal state', () => {
    // Denial messages are shown to the caller and fed back to the model.
    for (const decision of [
      authorizeDelegation(request({ delegate: undefined })),
      authorizeDelegation(request({ delegate: agent({ id: 'child', enabled: false }) })),
      authorizeDelegation(request({ principal: customerPrincipal() })),
    ]) {
      expect(decision.allowed).toBe(false);
      if (decision.allowed) continue;
      expect(decision.message).not.toContain('allowlist');
      expect(decision.message.length).toBeLessThan(120);
    }
  });
});

describe('describeChain', () => {
  it('renders the chain in call order', () => {
    expect(
      describeChain([
        { agentId: 'a', agentName: 'Research' },
        { agentId: 'b', agentName: 'Summariser' },
      ]),
    ).toBe('Research → Summariser');
  });

  it('handles an empty stack', () => {
    expect(describeChain([])).toBe('');
  });
});
