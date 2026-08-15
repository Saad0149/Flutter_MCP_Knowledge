/// Flutter Knowledge MCP — Dart symbol extractor using package:analyzer.
///
/// Reads JSON from stdin:
///   { "root": "/abs/path", "files": ["lib/a.dart", ...] }
/// Writes JSON to stdout:
///   { "files": [ { "path": "...", "symbols": [ ... ] } ] }
library;

import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/analysis_context_collection.dart';
import 'package:analyzer/dart/analysis/results.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/source/line_info.dart';
import 'package:path/path.dart' as p;

/// Printed immediately before our JSON payload so the Node side can locate it
/// even if `dart run` itself prints preamble noise to stdout ahead of us
/// (e.g. "Running build hooks..." from the native-assets/hooks feature on
/// some Dart SDK versions — a known SDK wart, not something this script can
/// control). Must stay in sync with `JSON_MARKER` in dart-analyzer-client.ts.
const jsonMarker = '@@FLUTTER_KNOWLEDGE_JSON@@';

void _writeJson(Object payload) {
  stdout.writeln(jsonMarker);
  stdout.writeln(jsonEncode(payload));
}

Future<void> main() async {
  try {
    final input = await stdin.transform(utf8.decoder).join();
    if (input.trim().isEmpty) {
      _writeJson({'files': <Object>[]});
      return;
    }

    final decoded = jsonDecode(input) as Map<String, dynamic>;
    final root = decoded['root'] as String;
    final files = (decoded['files'] as List<dynamic>).cast<String>();

    final absoluteFiles = files
        .map((f) => p.normalize(p.isAbsolute(f) ? f : p.join(root, f)))
        .toList();

    final collection = AnalysisContextCollection(
      includedPaths: absoluteFiles.isEmpty ? [root] : absoluteFiles,
    );

    final results = <Map<String, dynamic>>[];

    for (final absolute in absoluteFiles) {
      final context = collection.contextFor(absolute);
      final session = context.currentSession;
      final parsed = session.getParsedUnit(absolute);

      if (parsed is! ParsedUnitResult) {
        results.add({
          'path': p.relative(absolute, from: root).replaceAll(r'\', '/'),
          'symbols': <Object>[],
          'error': 'Failed to parse unit',
        });
        continue;
      }

      final visitor = _SymbolVisitor(parsed.lineInfo);
      parsed.unit.visitChildren(visitor);

      results.add({
        'path': p.relative(absolute, from: root).replaceAll(r'\', '/'),
        'symbols': visitor.symbols,
        'metrics': {
          'branchCount': visitor.branchCount,
          'maxNestingDepth': visitor.maxNestingDepth,
          'buildMethods': visitor.buildMethods,
          'listViewEagerCalls': visitor.listViewEagerCalls,
        },
      });
    }

    _writeJson({'files': results});
  } catch (e, st) {
    stderr.writeln('$e\n$st');
    _writeJson({'error': e.toString(), 'files': <Object>[]});
    exitCode = 1;
  }
}

class _SymbolVisitor extends RecursiveAstVisitor<void> {
  _SymbolVisitor(this.lineInfo);

  final LineInfo lineInfo;
  final List<Map<String, dynamic>> symbols = [];

  /// McCabe-style decision-point count: one per `if`/`for`/`while`/`do`,
  /// per `case`, per `catch`, per `&&`/`||`, and per ternary — real AST
  /// nodes only, so string/comment content and the nullable-type `?`
  /// suffix (a [NamedType], not a [ConditionalExpression]) can't inflate it
  /// the way the old whole-file regex did.
  int branchCount = 0;

  /// Max nesting depth of actual control-flow blocks (if/for/while/do/
  /// switch/try/catch bodies) — not brace-depth across the whole file, so
  /// nested map/list literals no longer count as nesting.
  int maxNestingDepth = 0;
  int _depth = 0;

  final List<Map<String, dynamic>> buildMethods = [];
  final List<Map<String, dynamic>> listViewEagerCalls = [];

  int _lineAt(int offset) => lineInfo.getLocation(offset).lineNumber;

  void _descend(void Function() visitBody) {
    _depth += 1;
    if (_depth > maxNestingDepth) {
      maxNestingDepth = _depth;
    }
    visitBody();
    _depth -= 1;
  }

  @override
  void visitClassDeclaration(ClassDeclaration node) {
    final name = node.name.lexeme;
    final extendsClause = node.extendsClause?.superclass.toSource();
    final withClause = node.withClause?.mixinTypes.map((t) => t.toSource()).join(', ');
    final implementsClause =
        node.implementsClause?.interfaces.map((t) => t.toSource()).join(', ');
    final isWidget = _looksLikeWidget(name, extendsClause, withClause, implementsClause);

    symbols.add({
      'name': name,
      'kind': 'class',
      'line': _lineAt(node.name.offset),
      'isWidget': isWidget,
      'docstring': _docComment(node),
      'packageName': null,
      'extendsClause': extendsClause,
      'withClause': withClause,
      'implementsClause': implementsClause,
    });

    for (final member in node.members) {
      if (member is MethodDeclaration) {
        symbols.add({
          'name': member.name.lexeme,
          'kind': 'method',
          'line': _lineAt(member.name.offset),
          'isWidget': false,
          'docstring': _docComment(member),
          'packageName': null,
          'extendsClause': null,
          'withClause': null,
          'implementsClause': null,
        });

        // Real build() method body span (offsets from the parsed body node
        // itself) — replaces manual brace-matching over raw text.
        if (member.name.lexeme == 'build' && member.returnType?.toSource() == 'Widget') {
          final body = member.body;
          final startLine = _lineAt(body.offset);
          final endLine = _lineAt(body.end);
          buildMethods.add({
            'line': _lineAt(member.name.offset),
            'startLine': startLine,
            'endLine': endLine,
            'approxLines': endLine - startLine + 1,
          });
        }
      } else if (member is ConstructorDeclaration) {
        final ctorName = member.name?.lexeme ?? name;
        symbols.add({
          'name': ctorName,
          'kind': 'constructor',
          'line': _lineAt(member.offset),
          'isWidget': false,
          'docstring': _docComment(member),
          'packageName': null,
          'extendsClause': null,
          'withClause': null,
          'implementsClause': null,
        });
      }
    }

    super.visitClassDeclaration(node);
  }

  @override
  void visitMixinDeclaration(MixinDeclaration node) {
    symbols.add({
      'name': node.name.lexeme,
      'kind': 'mixin',
      'line': _lineAt(node.name.offset),
      'isWidget': false,
      'docstring': _docComment(node),
      'packageName': null,
      'extendsClause': null,
      'withClause': null,
      'implementsClause': null,
    });
    super.visitMixinDeclaration(node);
  }

  @override
  void visitEnumDeclaration(EnumDeclaration node) {
    symbols.add({
      'name': node.name.lexeme,
      'kind': 'enum',
      'line': _lineAt(node.name.offset),
      'isWidget': false,
      'docstring': _docComment(node),
      'packageName': null,
      'extendsClause': null,
      'withClause': null,
      'implementsClause': null,
    });
    super.visitEnumDeclaration(node);
  }

  @override
  void visitExtensionDeclaration(ExtensionDeclaration node) {
    final nameToken = node.name;
    if (nameToken != null) {
      symbols.add({
        'name': nameToken.lexeme,
        'kind': 'extension',
        'line': _lineAt(nameToken.offset),
        'isWidget': false,
        'docstring': _docComment(node),
        'packageName': null,
        'extendsClause': null,
        'withClause': null,
        'implementsClause': null,
      });
    }
    super.visitExtensionDeclaration(node);
  }

  @override
  void visitFunctionDeclaration(FunctionDeclaration node) {
    symbols.add({
      'name': node.name.lexeme,
      'kind': 'function',
      'line': _lineAt(node.name.offset),
      'isWidget': false,
      'docstring': _docComment(node),
      'packageName': null,
      'extendsClause': null,
      'withClause': null,
      'implementsClause': null,
    });
    super.visitFunctionDeclaration(node);
  }

  @override
  void visitIfStatement(IfStatement node) {
    branchCount += 1;
    node.expression.accept(this);
    _descend(() => node.thenStatement.accept(this));
    final elseStatement = node.elseStatement;
    if (elseStatement != null) {
      if (elseStatement is IfStatement) {
        // `else if` continues the chain at the same nesting level as the
        // first `if` — only its own thenStatement goes one level deeper.
        elseStatement.accept(this);
      } else {
        _descend(() => elseStatement.accept(this));
      }
    }
  }

  @override
  void visitForStatement(ForStatement node) {
    branchCount += 1;
    node.forLoopParts.accept(this);
    _descend(() => node.body.accept(this));
  }

  @override
  void visitWhileStatement(WhileStatement node) {
    branchCount += 1;
    node.condition.accept(this);
    _descend(() => node.body.accept(this));
  }

  @override
  void visitDoStatement(DoStatement node) {
    branchCount += 1;
    _descend(() => node.body.accept(this));
    node.condition.accept(this);
  }

  @override
  void visitSwitchStatement(SwitchStatement node) {
    node.expression.accept(this);
    _descend(() {
      for (final member in node.members) {
        member.accept(this);
      }
    });
  }

  @override
  void visitSwitchCase(SwitchCase node) {
    branchCount += 1;
    super.visitSwitchCase(node);
  }

  @override
  void visitSwitchPatternCase(SwitchPatternCase node) {
    branchCount += 1;
    super.visitSwitchPatternCase(node);
  }

  @override
  void visitTryStatement(TryStatement node) {
    _descend(() => node.body.accept(this));
    for (final catchClause in node.catchClauses) {
      catchClause.accept(this);
    }
    final finallyBlock = node.finallyBlock;
    if (finallyBlock != null) {
      _descend(() => finallyBlock.accept(this));
    }
  }

  @override
  void visitCatchClause(CatchClause node) {
    branchCount += 1;
    _descend(() => super.visitCatchClause(node));
  }

  @override
  void visitConditionalExpression(ConditionalExpression node) {
    branchCount += 1;
    super.visitConditionalExpression(node);
  }

  @override
  void visitBinaryExpression(BinaryExpression node) {
    final op = node.operator.lexeme;
    if (op == '&&' || op == '||') {
      branchCount += 1;
    }
    super.visitBinaryExpression(node);
  }

  @override
  void visitInstanceCreationExpression(InstanceCreationExpression node) {
    // Reached for explicit `new ListView(...)` / `const ListView(...)` —
    // the `new`/`const` keyword is what lets the *parser* (no type
    // resolution here) disambiguate a constructor call from a same-named
    // top-level function call syntactically.
    _checkListViewChildrenCall(
      node.constructorName.type.toSource(),
      node.constructorName.name?.name,
      node.argumentList,
      node.offset,
    );
    super.visitInstanceCreationExpression(node);
  }

  @override
  void visitMethodInvocation(MethodInvocation node) {
    // Without `new`/`const`, a bare `ListView(...)` call parses as a
    // MethodInvocation at the syntactic level (not InstanceCreationExpression
    // — that rewrite only happens once the identifier is resolved), so the
    // overwhelmingly common modern `ListView(children: [...])` call site has
    // to be caught here, not in visitInstanceCreationExpression alone.
    // `ListView.builder(...)`/`.separated(...)` have a non-null target and
    // are correctly excluded — they're the recommended lazy constructors.
    if (node.target == null) {
      _checkListViewChildrenCall(node.methodName.name, null, node.argumentList, node.offset);
    }
    super.visitMethodInvocation(node);
  }

  void _checkListViewChildrenCall(
    String typeName,
    String? namedConstructor,
    ArgumentList argumentList,
    int offset,
  ) {
    if (typeName != 'ListView' || namedConstructor != null) {
      return;
    }
    final hasChildrenArg = argumentList.arguments.any(
      (a) => a is NamedExpression && a.name.label.name == 'children',
    );
    if (hasChildrenArg) {
      listViewEagerCalls.add({'line': _lineAt(offset)});
    }
  }

  String? _docComment(AnnotatedNode node) {
    final comment = node.documentationComment;
    if (comment == null) {
      return null;
    }
    return comment.tokens.map((t) => t.lexeme.replaceFirst(RegExp(r'^///\s?'), '')).join('\n');
  }

  bool _looksLikeWidget(
    String name,
    String? extendsClause,
    String? withClause,
    String? implementsClause,
  ) {
    if (name.endsWith('Widget') || name == 'Widget') {
      return true;
    }
    final haystack = [extendsClause, withClause, implementsClause].whereType<String>().join(' ');
    return RegExp(r'Widget|StatelessWidget|StatefulWidget|RenderObjectWidget').hasMatch(haystack);
  }
}
