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

Future<void> main() async {
  try {
    final input = await stdin.transform(utf8.decoder).join();
    if (input.trim().isEmpty) {
      stdout.writeln(jsonEncode({'files': <Object>[]}));
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
      });
    }

    stdout.writeln(jsonEncode({'files': results}));
  } catch (e, st) {
    stderr.writeln('$e\n$st');
    stdout.writeln(jsonEncode({'error': e.toString(), 'files': <Object>[]}));
    exitCode = 1;
  }
}

class _SymbolVisitor extends RecursiveAstVisitor<void> {
  _SymbolVisitor(this.lineInfo);

  final LineInfo lineInfo;
  final List<Map<String, dynamic>> symbols = [];

  int _lineAt(int offset) => lineInfo.getLocation(offset).lineNumber;

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
