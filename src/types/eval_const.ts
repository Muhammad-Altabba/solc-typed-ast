import Decimal from "decimal.js";
import {
    BinaryOperation,
    Conditional,
    EtherUnit,
    Expression,
    FunctionCall,
    FunctionCallKind,
    Identifier,
    Literal,
    LiteralKind,
    TimeUnit,
    TupleExpression,
    UnaryOperation,
    VariableDeclaration
} from "../ast";
import { pp } from "../misc";
import { BINARY_OPERATOR_GROUPS, SUBDENOMINATION_MULTIPLIERS } from "./utils";
/**
 * Tune up precision of decimal values to follow Solidity behavior.
 * Be careful with precision - setting it to large values causes NodeJS to crash.
 *
 * @see https://mikemcl.github.io/decimal.js/#precision
 */
Decimal.set({ precision: 100 });

export type Value = Decimal | boolean | string | bigint;

export class EvalError extends Error {
    expr?: Expression;

    constructor(msg: string, expr?: Expression) {
        super(msg);

        this.expr = expr;
    }
}

export class NonConstantExpressionError extends EvalError {
    constructor(expr: Expression) {
        super(`Found non-constant expression ${pp(expr)} during constant evaluation`, expr);
    }
}

function str(value: Value): string {
    return value instanceof Decimal ? value.toString() : pp(value);
}

function promoteToDec(v: Value): Decimal {
    if (!(typeof v === "bigint" || v instanceof Decimal)) {
        throw new Error(`Expected number not ${v}`);
    }

    return v instanceof Decimal ? v : new Decimal(v.toString());
}

function demoteFromDec(d: Decimal): Decimal | bigint {
    return d.isInt() ? BigInt(d.toFixed()) : d;
}

export function isConstant(expr: Expression): boolean {
    if (expr instanceof Literal) {
        return true;
    }

    if (expr instanceof UnaryOperation && isConstant(expr.vSubExpression)) {
        return true;
    }

    if (
        expr instanceof BinaryOperation &&
        isConstant(expr.vLeftExpression) &&
        isConstant(expr.vRightExpression)
    ) {
        return true;
    }

    if (
        expr instanceof TupleExpression &&
        !expr.isInlineArray &&
        expr.vOriginalComponents.length === 1 &&
        expr.vOriginalComponents[0] &&
        isConstant(expr.vOriginalComponents[0])
    ) {
        return true;
    }

    /// TODO: We can be more precise here. Conditionals are also constant if
    /// 1) vCondition is constant, and only the selected branch is constant
    /// 2) vCondition is not constant, but both branches are constant and equal (not likely in practice)
    if (
        expr instanceof Conditional &&
        isConstant(expr.vCondition) &&
        isConstant(expr.vTrueExpression) &&
        isConstant(expr.vFalseExpression)
    ) {
        return true;
    }

    if (expr instanceof Identifier) {
        const decl = expr.vReferencedDeclaration;

        if (
            decl instanceof VariableDeclaration &&
            decl.constant &&
            decl.vValue &&
            isConstant(decl.vValue)
        ) {
            return true;
        }
    }

    if (
        expr instanceof FunctionCall &&
        expr.kind === FunctionCallKind.TypeConversion &&
        isConstant(expr.vArguments[0])
    ) {
        return true;
    }

    return false;
}

export function evalLiteralImpl(
    kind: LiteralKind,
    value: string,
    subdenomination?: TimeUnit | EtherUnit
): Value {
    if (kind === LiteralKind.Bool) {
        return value === "true";
    }

    if (
        kind === LiteralKind.String ||
        kind === LiteralKind.UnicodeString ||
        kind === LiteralKind.HexString
    ) {
        return value;
    }

    if (kind === LiteralKind.Number) {
        const dec = new Decimal(value.replaceAll("_", ""));
        const val = dec.isInteger() ? BigInt(dec.toFixed()) : dec;

        if (subdenomination) {
            const multiplier = SUBDENOMINATION_MULTIPLIERS.get(subdenomination);

            if (multiplier === undefined) {
                throw new EvalError(`Unknown denomination ${subdenomination}`);
            }

            if (val instanceof Decimal) {
                return demoteFromDec(val.times(multiplier));
            }

            return val * BigInt(multiplier.toFixed());
        }

        return val;
    }

    throw new EvalError(`Unsupported literal kind "${kind}"`);
}

export function evalUnaryImpl(operator: string, value: Value): Value {
    if (operator === "!") {
        if (typeof value === "boolean") {
            return !value;
        }

        throw new EvalError(`Expected ${str(value)} to be boolean`);
    }

    if (operator === "~") {
        if (typeof value === "bigint") {
            return ~value;
        }

        throw new EvalError(`Expected ${str(value)} to be a bigint`);
    }

    if (operator === "+") {
        if (value instanceof Decimal || typeof value === "bigint") {
            return value;
        }

        throw new EvalError(`Expected ${str(value)} to be a bigint or a decimal`);
    }

    if (operator === "-") {
        if (value instanceof Decimal) {
            return value.negated();
        }

        if (typeof value === "bigint") {
            return -value;
        }

        throw new EvalError(`Expected ${str(value)} to be a bigint or a decimal`);
    }

    throw new EvalError(`Unable to process ${operator}${str(value)}`);
}

export function evalBinaryImpl(operator: string, left: Value, right: Value): Value {
    if (BINARY_OPERATOR_GROUPS.Logical.includes(operator)) {
        if (!(typeof left === "boolean" && typeof right === "boolean")) {
            throw new EvalError(`${operator} expects booleans not ${str(left)} and ${str(right)}`);
        }

        if (operator === "&&") {
            return left && right;
        }

        if (operator === "||") {
            return left || right;
        }

        throw new EvalError(`Unknown logical operator ${operator}`);
    }

    if (BINARY_OPERATOR_GROUPS.Equality.includes(operator)) {
        if (typeof left === "string" || typeof right === "string") {
            throw new EvalError(
                `${operator} not allowed for strings ${str(left)} and ${str(right)}`
            );
        }

        let isEqual: boolean;

        if (left instanceof Decimal && right instanceof Decimal) {
            isEqual = left.equals(right);
        } else {
            isEqual = left === right;
        }

        if (operator === "==") {
            return isEqual;
        }

        if (operator === "!=") {
            return !isEqual;
        }

        throw new EvalError(`Unknown equality operator ${operator}`);
    }

    if (BINARY_OPERATOR_GROUPS.Comparison.includes(operator)) {
        const leftDec = promoteToDec(left);
        const rightDec = promoteToDec(right);

        if (operator === "<") {
            return leftDec.lessThan(rightDec);
        }

        if (operator === "<=") {
            return leftDec.lessThanOrEqualTo(rightDec);
        }

        if (operator === ">") {
            return leftDec.greaterThan(rightDec);
        }

        if (operator === ">=") {
            return leftDec.greaterThanOrEqualTo(rightDec);
        }

        throw new EvalError(`Unknown comparison operator ${operator}`);
    }

    if (BINARY_OPERATOR_GROUPS.Arithmetic.includes(operator)) {
        const leftDec = promoteToDec(left);
        const rightDec = promoteToDec(right);

        let res: Decimal;

        if (operator === "+") {
            res = leftDec.plus(rightDec);
        } else if (operator === "-") {
            res = leftDec.minus(rightDec);
        } else if (operator === "*") {
            res = leftDec.times(rightDec);
        } else if (operator === "/") {
            res = leftDec.div(rightDec);
        } else if (operator === "%") {
            res = leftDec.modulo(rightDec);
        } else if (operator === "**") {
            res = leftDec.pow(rightDec);
        } else {
            throw new EvalError(`Unknown arithmetic operator ${operator}`);
        }

        return demoteFromDec(res);
    }

    if (BINARY_OPERATOR_GROUPS.Bitwise.includes(operator)) {
        if (!(typeof left === "bigint" && typeof right === "bigint")) {
            throw new EvalError(`${operator} expects integers not ${str(left)} and ${str(right)}`);
        }

        if (operator === "<<") {
            return left << right;
        }

        if (operator === ">>") {
            return left >> right;
        }

        if (operator === "|") {
            return left | right;
        }

        if (operator === "&") {
            return left & right;
        }

        if (operator === "^") {
            return left ^ right;
        }

        throw new EvalError(`Unknown bitwise operator ${operator}`);
    }

    throw new EvalError(`Unable to process ${str(left)} ${operator} ${str(right)}`);
}

export function evalLiteral(node: Literal): Value {
    try {
        return evalLiteralImpl(
            node.kind,
            node.kind === LiteralKind.HexString ? node.hexValue : node.value,
            node.subdenomination
        );
    } catch (e: unknown) {
        if (e instanceof EvalError) {
            e.expr = node;
        }

        throw e;
    }
}

export function evalUnary(node: UnaryOperation): Value {
    try {
        return evalUnaryImpl(node.operator, evalConstantExpr(node.vSubExpression));
    } catch (e: unknown) {
        if (e instanceof EvalError && e.expr === undefined) {
            e.expr = node;
        }

        throw e;
    }
}

export function evalBinary(node: BinaryOperation): Value {
    try {
        return evalBinaryImpl(
            node.operator,
            evalConstantExpr(node.vLeftExpression),
            evalConstantExpr(node.vRightExpression)
        );
    } catch (e: unknown) {
        if (e instanceof EvalError && e.expr === undefined) {
            e.expr = node;
        }

        throw e;
    }
}

/**
 * Given a constant expression `expr` evaluate it to a concrete `Value`.
 * If `expr` is not constant throw `NonConstantExpressionError`.
 *
 * TODO: The order of some operations changed in some version.
 * So perhaps to be fully precise here we will need a compiler version too?
 */
export function evalConstantExpr(node: Expression): Value {
    if (!isConstant(node)) {
        throw new NonConstantExpressionError(node);
    }

    if (node instanceof Literal) {
        return evalLiteral(node);
    }

    if (node instanceof UnaryOperation) {
        return evalUnary(node);
    }

    if (node instanceof BinaryOperation) {
        return evalBinary(node);
    }

    if (node instanceof TupleExpression) {
        return evalConstantExpr(node.vOriginalComponents[0] as Expression);
    }

    if (node instanceof Conditional) {
        return evalConstantExpr(node.vCondition)
            ? evalConstantExpr(node.vTrueExpression)
            : evalConstantExpr(node.vFalseExpression);
    }

    if (node instanceof Identifier) {
        const decl = node.vReferencedDeclaration;

        if (decl instanceof VariableDeclaration) {
            return evalConstantExpr(decl.vValue as Expression);
        }
    }

    if (node instanceof FunctionCall) {
        /**
         * @todo Implement properly, as Solidity permits overflow and underflow
         * during constant evaluation when performing type conversions.
         */
        return evalConstantExpr(node.vArguments[0]);
    }

    /// Note that from the point of view of the type system constant conditionals and
    /// indexing in constant array literals are not considered constant expressions.
    /// So for now we don't support them, but we may change that in the future.
    throw new EvalError(`Unable to evaluate constant expression ${pp(node)}`, node);
}