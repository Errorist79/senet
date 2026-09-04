import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTRACT_MAX_TTL_LEDGERS, LIFETIMES } from '@senet/core';
import { ContractLimitsMismatchError, assertContractLimits } from '../src/index.js';
import type { ContractLimits } from '../src/index.js';

const CONTRACT = 'CADGZVNCAFRHJ44P33RODTVXGXCX5EMVCYFHYFMGWNFYVILC556XGWBY';

/** Limits with a chosen lifetime ceiling. */
function limitsWith(maxTtlLedgers: number): ContractLimits {
  return { maxAmountStroops: 1_000_000_000n, maxTtlLedgers };
}

test('a contract that matches this build passes', () => {
  assert.doesNotThrow(() =>
    assertContractLimits(CONTRACT, limitsWith(CONTRACT_MAX_TTL_LEDGERS)),
  );
});

test('a contract with a shorter ceiling stops the service', () => {
  // The payer would sign a 12 hour voucher that the contract then refuses.
  assert.throws(
    () => assertContractLimits(CONTRACT, limitsWith(LIFETIMES['1h'])),
    (error: unknown) => {
      assert.ok(error instanceof ContractLimitsMismatchError);
      assert.equal(error.deployedMaxTtlLedgers, LIFETIMES['1h']);
      assert.equal(error.expectedMaxTtlLedgers, CONTRACT_MAX_TTL_LEDGERS);
      assert.equal(error.contractId, CONTRACT);
      return true;
    },
  );
});

test('a contract with a longer ceiling also stops the service', () => {
  // The two numbers must agree. A longer ceiling means this build offers less
  // than the contract allows, and the disagreement is still a defect.
  assert.throws(
    () => assertContractLimits(CONTRACT, limitsWith(CONTRACT_MAX_TTL_LEDGERS + 1)),
    ContractLimitsMismatchError,
  );
});

test('the longest lifetime on offer equals the ceiling that the check reads', () => {
  assert.equal(CONTRACT_MAX_TTL_LEDGERS, LIFETIMES['12h']);
});
