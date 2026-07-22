const VALID_DIRECTIONS = new Set(['bullish', 'bearish', 'neutral']);

function diagnostic(name, code, severity, field, message) {
  return { name, code, severity, field, message };
}

function typeOf(value) {
  return value === null ? 'null' : typeof value;
}

function ownDescriptor(object, field) {
  let current = object;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, field);
    if (descriptor) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function readField(object, field) {
  const descriptor = ownDescriptor(object, field);
  if (!descriptor) return { present: false, value: undefined };
  if (!Object.hasOwn(descriptor, 'value')) return { present: true, accessor: true };
  return { present: true, value: descriptor.value };
}

function inspectDefinitionInternal(name, component) {
  const diagnostics = [];

  if (name === undefined) {
    diagnostics.push(diagnostic(name, 'COMPONENT_NAME_UNDEFINED', 'WARNING', 'name', 'Component name is undefined'));
  } else if (name === null) {
    diagnostics.push(diagnostic(name, 'COMPONENT_NAME_NULL', 'WARNING', 'name', 'Component name is null'));
  } else if (typeof name !== 'string') {
    diagnostics.push(diagnostic(name, 'COMPONENT_NAME_NON_STRING', 'INFO', 'name', 'Component name is not a string'));
  } else if (name.length === 0) {
    diagnostics.push(diagnostic(name, 'COMPONENT_NAME_EMPTY', 'WARNING', 'name', 'Component name is empty'));
  }

  if (component === null || (typeof component !== 'object' && typeof component !== 'function')) {
    diagnostics.push(diagnostic(name, 'COMPONENT_DEFINITION_INVALID', 'ERROR', 'component', 'Component definition is not an object'));
    return diagnostics;
  }

  const weight = readField(component, 'weight');
  if (!weight.present || weight.value === undefined) {
    diagnostics.push(diagnostic(name, 'COMPONENT_WEIGHT_MISSING', 'WARNING', 'weight', 'Component weight is missing'));
  } else if (weight.accessor) {
    diagnostics.push(diagnostic(name, 'COMPONENT_WEIGHT_UNSAFE_ACCESSOR', 'WARNING', 'weight', 'Component weight uses an accessor'));
  } else if (weight.value === null) {
    diagnostics.push(diagnostic(name, 'COMPONENT_WEIGHT_NULL', 'WARNING', 'weight', 'Component weight is null'));
  } else if (typeof weight.value !== 'number') {
    diagnostics.push(diagnostic(name, 'COMPONENT_WEIGHT_NON_NUMERIC', 'WARNING', 'weight', 'Component weight is not numeric'));
  } else if (Number.isNaN(weight.value)) {
    diagnostics.push(diagnostic(name, 'COMPONENT_WEIGHT_NAN', 'ERROR', 'weight', 'Component weight is NaN'));
  } else if (!Number.isFinite(weight.value)) {
    diagnostics.push(diagnostic(name, 'COMPONENT_WEIGHT_INFINITE', 'ERROR', 'weight', 'Component weight is infinite'));
  } else if (weight.value < 0) {
    diagnostics.push(diagnostic(name, 'COMPONENT_WEIGHT_NEGATIVE', 'WARNING', 'weight', 'Component weight is negative'));
  } else if (weight.value === 0) {
    diagnostics.push(diagnostic(name, 'COMPONENT_WEIGHT_ZERO', 'INFO', 'weight', 'Component weight is zero'));
  }

  const calculate = readField(component, 'calculate');
  if (!calculate.present || calculate.value === undefined) {
    diagnostics.push(diagnostic(name, 'COMPONENT_CALCULATE_MISSING', 'ERROR', 'calculate', 'Component calculate function is missing'));
  } else if (calculate.accessor) {
    diagnostics.push(diagnostic(name, 'COMPONENT_CALCULATE_UNSAFE_ACCESSOR', 'ERROR', 'calculate', 'Component calculate function uses an accessor'));
  } else if (typeof calculate.value !== 'function') {
    diagnostics.push(diagnostic(name, 'COMPONENT_CALCULATE_INVALID', 'ERROR', 'calculate', 'Component calculate value is not a function'));
  }

  const keys = Object.keys(component);
  if (keys.some(key => key !== 'weight' && key !== 'calculate')) {
    diagnostics.push(diagnostic(name, 'COMPONENT_EXTRA_FIELDS', 'INFO', 'component', 'Component definition contains extra fields'));
  }

  return diagnostics;
}

function inspectResultInternal(name, rawResult) {
  const diagnostics = [];

  if (rawResult === null || rawResult === undefined) {
    diagnostics.push(diagnostic(name, 'RESULT_NOT_OBJECT', 'ERROR', 'result', 'Component result is not an object'));
    return diagnostics;
  }

  if (typeof rawResult !== 'object') {
    diagnostics.push(diagnostic(name, 'RESULT_NOT_OBJECT', 'ERROR', 'result', 'Component result is not an object'));
    return diagnostics;
  }

  if (Array.isArray(rawResult)) {
    diagnostics.push(diagnostic(name, 'RESULT_ARRAY', 'WARNING', 'result', 'Component result is an array'));
  }

  const then = readField(rawResult, 'then');
  if (then.present && !then.accessor && typeof then.value === 'function') {
    diagnostics.push(diagnostic(name, 'RESULT_PROMISE_LIKE', 'ERROR', 'result', 'Component result is promise-like'));
  }

  const fields = ['score', 'direction', 'available', 'confidence', 'reason'];
  const values = Object.fromEntries(fields.map(field => [field, readField(rawResult, field)]));

  const score = values.score;
  if (!score.present || score.value === undefined) {
    diagnostics.push(diagnostic(name, 'RESULT_SCORE_MISSING', 'WARNING', 'score', 'Component score is missing'));
  } else if (score.accessor) {
    diagnostics.push(diagnostic(name, 'RESULT_SCORE_UNSAFE_ACCESSOR', 'WARNING', 'score', 'Component score uses an accessor'));
  } else if (score.value === null) {
    diagnostics.push(diagnostic(name, 'RESULT_SCORE_NULL', 'INFO', 'score', 'Component score is null'));
  } else if (typeof score.value !== 'number') {
    diagnostics.push(diagnostic(name, 'RESULT_SCORE_NON_NUMERIC', 'WARNING', 'score', 'Component score is not numeric'));
  } else if (Number.isNaN(score.value)) {
    diagnostics.push(diagnostic(name, 'RESULT_SCORE_NAN', 'ERROR', 'score', 'Component score is NaN'));
  } else if (!Number.isFinite(score.value)) {
    diagnostics.push(diagnostic(name, 'RESULT_SCORE_INFINITE', 'ERROR', 'score', 'Component score is infinite'));
  } else if (score.value < 0 || score.value > 100) {
    diagnostics.push(diagnostic(name, 'RESULT_SCORE_OUT_OF_RANGE', 'WARNING', 'score', 'Component score is outside 0-100'));
  }

  const direction = values.direction;
  if (!direction.present || direction.value === undefined) {
    diagnostics.push(diagnostic(name, 'RESULT_DIRECTION_MISSING', 'INFO', 'direction', 'Component direction is missing'));
  } else if (direction.accessor) {
    diagnostics.push(diagnostic(name, 'RESULT_DIRECTION_UNSAFE_ACCESSOR', 'WARNING', 'direction', 'Component direction uses an accessor'));
  } else if (direction.value === null) {
    diagnostics.push(diagnostic(name, 'RESULT_DIRECTION_NULL', 'INFO', 'direction', 'Component direction is null'));
  } else if (typeof direction.value !== 'string' || !VALID_DIRECTIONS.has(direction.value)) {
    diagnostics.push(diagnostic(name, 'RESULT_DIRECTION_INVALID', 'WARNING', 'direction', 'Component direction is invalid'));
  }

  const available = values.available;
  if (!available.present || available.value === undefined) {
    diagnostics.push(diagnostic(name, 'RESULT_AVAILABLE_MISSING', 'INFO', 'available', 'Component availability is missing'));
  } else if (available.accessor) {
    diagnostics.push(diagnostic(name, 'RESULT_AVAILABLE_UNSAFE_ACCESSOR', 'WARNING', 'available', 'Component availability uses an accessor'));
  } else if (typeof available.value !== 'boolean') {
    diagnostics.push(diagnostic(name, 'RESULT_AVAILABLE_NON_BOOLEAN', 'WARNING', 'available', 'Component availability is not boolean'));
  }

  const confidence = values.confidence;
  if (!confidence.present || confidence.value === undefined) {
    diagnostics.push(diagnostic(name, 'RESULT_CONFIDENCE_MISSING', 'INFO', 'confidence', 'Component confidence is missing'));
  } else if (confidence.accessor) {
    diagnostics.push(diagnostic(name, 'RESULT_CONFIDENCE_UNSAFE_ACCESSOR', 'WARNING', 'confidence', 'Component confidence uses an accessor'));
  } else if (confidence.value === null) {
    diagnostics.push(diagnostic(name, 'RESULT_CONFIDENCE_NULL', 'INFO', 'confidence', 'Component confidence is null'));
  } else if (typeof confidence.value !== 'number') {
    diagnostics.push(diagnostic(name, 'RESULT_CONFIDENCE_NON_NUMERIC', 'WARNING', 'confidence', 'Component confidence is not numeric'));
  } else if (Number.isNaN(confidence.value)) {
    diagnostics.push(diagnostic(name, 'RESULT_CONFIDENCE_NAN', 'ERROR', 'confidence', 'Component confidence is NaN'));
  } else if (!Number.isFinite(confidence.value)) {
    diagnostics.push(diagnostic(name, 'RESULT_CONFIDENCE_INFINITE', 'ERROR', 'confidence', 'Component confidence is infinite'));
  } else if (confidence.value < 0 || confidence.value > 100) {
    diagnostics.push(diagnostic(name, 'RESULT_CONFIDENCE_OUT_OF_RANGE', 'WARNING', 'confidence', 'Component confidence is outside 0-100'));
  }

  const reason = values.reason;
  if (reason.present && !reason.accessor && reason.value !== undefined && reason.value !== null && typeof reason.value !== 'string') {
    diagnostics.push(diagnostic(name, 'RESULT_REASON_NON_STRING', 'INFO', 'reason', 'Component reason is not a string'));
  } else if (reason.accessor) {
    diagnostics.push(diagnostic(name, 'RESULT_REASON_UNSAFE_ACCESSOR', 'INFO', 'reason', 'Component reason uses an accessor'));
  }

  if (Object.keys(rawResult).some(key => !fields.includes(key))) {
    diagnostics.push(diagnostic(name, 'RESULT_EXTRA_FIELDS', 'INFO', 'result', 'Component result contains extra fields'));
  }

  return diagnostics;
}

function validatorFailure(name) {
  return [diagnostic(name, 'VALIDATOR_INSPECTION_FAILED', 'ERROR', 'validator', 'Component inspection could not be completed')];
}

function inspectDefinition(name, component) {
  try {
    return inspectDefinitionInternal(name, component);
  } catch {
    return validatorFailure(name);
  }
}

function inspectResult(name, rawResult) {
  try {
    return inspectResultInternal(name, rawResult);
  } catch {
    return validatorFailure(name);
  }
}

module.exports = { inspectDefinition, inspectResult, VALID_DIRECTIONS };
