// Regenerate src/legacy/shader-rules.ts from the shared typed integer rules.
// This is source generation, not a runtime dependency. The deliberately small
// accepted TS subset fails closed when a rule introduces an unhandled syntax.
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const file = ts.createSourceFile('kernel.ts', readFileSync(new URL('src/legacy/kernel.ts', root), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fail = (n: ts.Node): never => { throw new Error(`Unsupported kernel syntax ${ts.SyntaxKind[n.kind]}: ${n.getText(file)}`); };
function type(n: ts.TypeNode | undefined): string {
  if (n?.kind === ts.SyntaxKind.NumberKeyword) return 'i32';
  if (n?.kind === ts.SyntaxKind.BooleanKeyword) return 'bool';
  if (n?.getText(file) === 'Seed') return 'vec2<u32>';
  throw new Error(`Explicit kernel value type required: ${n?.getText(file)}`);
}
function expr(n: ts.Expression): string {
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isNumericLiteral(n)) return n.text;
  if (n.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (n.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (ts.isParenthesizedExpression(n)) return `(${expr(n.expression)})`;
  if (ts.isPropertyAccessExpression(n)) {
    if (n.expression.getText(file) === 'c') {
      if (['mc', 'st', 'ss'].includes(n.name.text)) return `layers[u32(params.node)].${n.name.text}`;
    }
    return fail(n);
  }
  if (ts.isCallExpression(n)) {
    if (ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(file) === 'c') {
      const name = n.expression.name.text;
      if (name === 'noise') return `oceanTemp(${n.arguments.map(expr).join(',')})`;
      if (name === 'a' || name === 'b') return `sample(layers[u32(params.node)].${name},${n.arguments.map(expr).join(',')})`;
      return fail(n);
    }
    const name = n.expression.getText(file) === 'step' ? 'rngStep' : expr(n.expression);
    return `${name}(${n.arguments.map(expr).join(',')})`;
  }
  if (ts.isBinaryExpression(n)) {
    const token = n.operatorToken.getText(file);
    const op = token === '===' ? '==' : token === '!==' ? '!=' : token;
    // Assignments cannot be parenthesized in WGSL.
    const text = `${expr(n.left)} ${op} ${expr(n.right)}`;
    return n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? text : `(${text})`;
  }
  if (ts.isPrefixUnaryExpression(n)) return `${ts.tokenToString(n.operator)}(${expr(n.operand)})`;
  if (ts.isPostfixUnaryExpression(n)) return `${expr(n.operand)}${ts.tokenToString(n.operator)}`;
  if (ts.isConditionalExpression(n)) return `select(${expr(n.whenFalse)},${expr(n.whenTrue)},${expr(n.condition)})`;
  return fail(n);
}
function declarations(n: ts.VariableDeclarationList): string {
  return n.declarations.map(d => `${n.flags & ts.NodeFlags.Const ? 'let' : 'var'} ${d.name.getText(file)}: ${type(d.type)}${d.initializer ? ` = ${expr(d.initializer)}` : ''}`).join(';');
}
function block(n: ts.Statement): string { return ts.isBlock(n) ? statement(n) : `{${statement(n)}}`; }
function statement(n: ts.Statement): string {
  if (ts.isBlock(n)) return `{\n${n.statements.map(statement).join('\n')}\n}`;
  if (ts.isVariableStatement(n)) return declarations(n.declarationList) + ';';
  if (ts.isReturnStatement(n)) return `return${n.expression ? ' ' + expr(n.expression) : ''};`;
  if (ts.isExpressionStatement(n)) return expr(n.expression) + ';';
  if (ts.isIfStatement(n)) return `if(${expr(n.expression)})${block(n.thenStatement)}${n.elseStatement ? 'else ' + block(n.elseStatement) : ''}`;
  if (ts.isForStatement(n)) {
    if (!n.initializer || !ts.isVariableDeclarationList(n.initializer) || !n.condition || !n.incrementor) return fail(n);
    return `for(${declarations(n.initializer)};${expr(n.condition)};${expr(n.incrementor)})${block(n.statement)}`;
  }
  if (ts.isSwitchStatement(n)) {
    let selectors: string[] = [];
    const cases: string[] = [];
    for (const c of n.caseBlock.clauses) {
      selectors.push(ts.isCaseClause(c) ? expr(c.expression) : 'default');
      if (!c.statements.length) continue;
      const body = [...c.statements];
      if (body.length && ts.isBreakStatement(body[body.length - 1]!)) body.pop();
      cases.push(`${selectors[0] === 'default' ? 'default' : 'case ' + selectors.join(',')}: {${body.map(statement).join('\n')}}`);
      selectors = [];
    }
    if (selectors.length) throw new Error('Empty final switch clause');
    return `switch(${expr(n.expression)}){${cases.join('\n')}}`;
  }
  if (ts.isBreakStatement(n)) return 'break;';
  return fail(n);
}
const functions = file.statements.filter(ts.isFunctionDeclaration).map(fn => {
  if (!fn.body || !fn.name) return fail(fn);
  const params = fn.parameters.filter(p => p.type?.getText(file) !== 'CellContext').map(p => `${p.name.getText(file)}:${type(p.type)}`);
  return `fn ${fn.name.text}(${params.join(',')})->${type(fn.type)}${statement(fn.body)}`;
});
writeFileSync(new URL('src/legacy/shader-rules.ts', root), '// Generated by tools/export-legacy.ts from kernel.ts. Cubiomes MIT (Cubitect).\nexport const LEGACY_SHADER_RULES = ' + JSON.stringify(functions.join('\n')) + ';\n');
