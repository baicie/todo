export const DRIVER_STATUS = {
  FAIL: 'FAIL',
  NOT_RUN: 'NOT_RUN',
  PARTIAL: 'PARTIAL',
  PASS: 'PASS',
};

/**
 * A UIA driver result is not automatically the platform result.
 *
 * - FAIL/unknown/corrupt => FAIL (never downgrade a deterministic failure)
 * - NOT_RUN => NOT_RUN with the concrete environment/driver reason
 * - PARTIAL/PASS => continue to WebView business verification; a PASS from the
 *   driver alone is never accepted because UIA invoke is not task delivery.
 */
export function classifyDriverResult(driver) {
  if (!driver || typeof driver !== 'object' || Array.isArray(driver)) {
    return {
      kind: 'fail',
      status: 'FAIL',
      reason: 'Toast driver result is missing or not an object',
      verifyBusiness: false,
    };
  }
  if (typeof driver.status !== 'string' || !driver.status) {
    return {
      kind: 'fail',
      status: 'FAIL',
      reason: 'Toast driver result has no status',
      verifyBusiness: false,
    };
  }
  switch (driver.status) {
    case DRIVER_STATUS.FAIL:
      return {
        kind: 'fail',
        status: 'FAIL',
        reason: driver.error || 'Toast driver reported FAIL',
        verifyBusiness: false,
      };
    case DRIVER_STATUS.NOT_RUN:
      return {
        kind: 'not_run',
        status: 'NOT_RUN',
        reason: driver.error || 'Toast driver did not observe an actionable target',
        verifyBusiness: false,
      };
    case DRIVER_STATUS.PARTIAL:
      return {
        kind: 'verify',
        status: 'PARTIAL',
        reason: null,
        verifyBusiness: true,
      };
    case DRIVER_STATUS.PASS:
      // A driver cannot prove WebView delivery. Treat it as an invoke candidate
      // that still needs the business assertion.
      return {
        kind: 'verify',
        status: 'PASS',
        reason: 'Driver PASS is not accepted without WebView verification',
        verifyBusiness: true,
      };
    default:
      return {
        kind: 'fail',
        status: 'FAIL',
        reason: `Unknown Toast driver status: ${driver.status}`,
        verifyBusiness: false,
      };
  }
}

export function mapDriverResult(driver) {
  return classifyDriverResult(driver);
}
