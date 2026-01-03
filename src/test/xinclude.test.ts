import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { resolveXIncludes } from "../services/xinclude";

const testFolderLocation = "../../src/test/fixtures/";

suite("XInclude resolution", () => {
  test("Resolves xpointer selections by xml:id", async () => {
    const uri = vscode.Uri.file(
      path.join(__dirname, testFolderLocation, "xi_xpointer_source.xml")
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    const resolved = await resolveXIncludes(document.getText(), 0, document.uri);
    assert.ok(resolved.includes("<section xml:id=\"intro\">"), "Intro section not included");
    assert.ok(!resolved.includes("<section id=\"body\">"), "Non-target section should not be included");
  });

  test("Reports missing xpointer targets", async () => {
    const uri = vscode.Uri.file(
      path.join(__dirname, testFolderLocation, "xi_xpointer_missing.xml")
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    const resolved = await resolveXIncludes(document.getText(), 0, document.uri);
    assert.ok(resolved.includes("<?xml-xi-error"), "Missing xpointer should emit error PI");
  });

  test("Resolves xpointer selections by element() path", async () => {
    const uri = vscode.Uri.file(
      path.join(__dirname, testFolderLocation, "xi_xpointer_element_source.xml")
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    const resolved = await resolveXIncludes(document.getText(), 0, document.uri);
    assert.ok(resolved.includes("<section xml:id=\"intro\">"), "Intro section not included");
    assert.ok(!resolved.includes("<section id=\"body\">"), "Non-target section should not be included");
  });

  test("Resolves xpointer element() selections by xml:id anchor", async () => {
    const uri = vscode.Uri.file(
      path.join(__dirname, testFolderLocation, "xi_xpointer_element_id_source.xml")
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    const resolved = await resolveXIncludes(document.getText(), 0, document.uri);
    assert.ok(resolved.includes("<p>Intro text.</p>"), "Anchored element() selection not included");
  });

  test("Reports out-of-range xpointer element() steps", async () => {
    const uri = vscode.Uri.file(
      path.join(__dirname, testFolderLocation, "xi_xpointer_element_id_missing.xml")
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    const resolved = await resolveXIncludes(document.getText(), 0, document.uri);
    assert.ok(resolved.includes("<?xml-xi-error"), "Out-of-range element() should emit error PI");
    assert.ok(resolved.includes("step 1 out of range"), "Missing step diagnostic not included");
  });

  test("Resolves xpointer element() root selection", async () => {
    const uri = vscode.Uri.file(
      path.join(__dirname, testFolderLocation, "xi_xpointer_element_root_source.xml")
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    const resolved = await resolveXIncludes(document.getText(), 0, document.uri);
    assert.ok(resolved.includes("<root>"), "Root element not included");
    assert.ok(resolved.includes("<section xml:id=\"intro\">"), "Intro section not included");
  });

  test("Resolves XInclude href with non-ASCII filename", async () => {
    const uri = vscode.Uri.file(
      path.join(__dirname, testFolderLocation, "xi_non_ascii_source.xml")
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    const resolved = await resolveXIncludes(document.getText(), 0, document.uri);
    assert.ok(resolved.includes("<included>Non-ASCII filename</included>"));
  });
});
