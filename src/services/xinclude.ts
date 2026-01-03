import { XINCLUDE_LOCAL, XINCLUDE_NS } from "../constants";
import { normalizeSchemaUrl } from "../utils";
import { SaxesParser } from "saxes";
import { Uri, window, workspace } from "vscode";

import type { SaxesAttributeNS, SaxesTag } from "saxes";

const XML_NS = "http://www.w3.org/XML/1998/namespace";

function normalizeXPointer(xpointer: string): string {
  const trimmed = xpointer.trim();
  const wrapped = trimmed.match(/^xpointer\((.+)\)$/);
  const inner = wrapped ? wrapped[1].trim() : trimmed;
  const idMatch = inner.match(/^id\(['"]([^'"]+)['"]\)$/);
  return idMatch ? idMatch[1] : inner;
}

function matchesId(attributes: Record<string, SaxesAttributeNS>, targetId: string): boolean {
  return Object.values(attributes).some((attr) => {
    if (attr.local !== "id") {
      return false;
    }
    const isXmlId = attr.uri === XML_NS || attr.prefix === "xml";
    const isPlainId = !attr.prefix;
    return (isXmlId || isPlainId) && attr.value === targetId;
  });
}

type ElementScheme =
  | { type: "positional"; steps: number[] }
  | { type: "id"; id: string; steps: number[] };

function parseElementScheme(xpointer: string): ElementScheme | null {
  const trimmed = xpointer.trim();
  const wrapped = trimmed.match(/^xpointer\((.+)\)$/);
  const inner = wrapped ? wrapped[1].trim() : trimmed;
  const elementMatch = inner.match(/^element\((.+)\)$/);
  if (!elementMatch) {
    return null;
  }
  const content = elementMatch[1].trim();
  if (!content) {
    throw new Error("Empty element() XPointer.");
  }

  const tokens = content.split("/").filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Empty element() XPointer.");
  }

  const isIntegerToken = (token: string) => /^[1-9]\d*$/.test(token);
  const first = tokens[0];
  if (isIntegerToken(first)) {
    const steps = tokens.map((token) => {
      if (!isIntegerToken(token)) {
        throw new Error(`Invalid element() step: ${token}`);
      }
      return Number(token);
    });
    return { type: "positional", steps };
  }

  const steps = tokens.slice(1).map((token) => {
    if (!isIntegerToken(token)) {
      throw new Error(`Invalid element() step: ${token}`);
    }
    return Number(token);
  });
  return { type: "id", id: first, steps };
}

function selectXPointerFragment(xmlSource: string, xpointer: string): string {
  const elementScheme = parseElementScheme(xpointer);
  const targetId = elementScheme ? null : normalizeXPointer(xpointer);
  if (!elementScheme && !targetId) {
    throw new Error("Empty xpointer target.");
  }

  const parser = new SaxesParser({ xmlns: true, position: true });
  let depth = 0;
  let found = false;
  let targetDepth: number | null = null;
  let startPos = -1;
  let endPos = -1;
  const childCounts: number[] = [0];
  const elementPath: number[] = [];
  const positionalCounts: number[] = [];
  const idCounts: number[] = [];
  let idAnchorPath: number[] | null = null;
  let idAnchorFound = false;

  const matchesPath = (path: number[], target: number[]) =>
    path.length === target.length && path.every((step, index) => step === target[index]);

  parser.on("opentag", (node: SaxesTag) => {
    depth += 1;
    const parentIndex = childCounts.length - 1;
    childCounts[parentIndex] += 1;
    const currentIndex = childCounts[parentIndex];
    childCounts.push(0);
    elementPath.push(currentIndex);
    if (found) {
      return;
    }

    const markTarget = () => {
      found = true;
      const tagStartPosition = xmlSource.lastIndexOf("<", parser.position - 1);
      if (tagStartPosition === -1) {
        throw new Error("Could not find start of xpointer target.");
      }
      startPos = tagStartPosition;
      targetDepth = depth;
      if (node.isSelfClosing) {
        endPos = parser.position;
        targetDepth = null;
      }
    };

    if (elementScheme?.type === "positional") {
      if (matchesPath(elementPath, elementScheme.steps)) {
        markTarget();
      }
      return;
    }

    if (elementScheme?.type === "id") {
      if (!idAnchorFound && matchesId(node.attributes as Record<string, SaxesAttributeNS>, elementScheme.id)) {
        idAnchorFound = true;
        idAnchorPath = [...elementPath];
        if (elementScheme.steps.length === 0) {
          markTarget();
        }
      }
      if (idAnchorFound && idAnchorPath) {
        const matchesAnchor = elementPath.length > idAnchorPath.length &&
          matchesPath(elementPath.slice(0, idAnchorPath.length), idAnchorPath);
        if (matchesAnchor) {
          const relativePath = elementPath.slice(idAnchorPath.length);
          if (matchesPath(relativePath, elementScheme.steps)) {
            markTarget();
          }
        }
      }
      return;
    }

    if (targetId && matchesId(node.attributes as Record<string, SaxesAttributeNS>, targetId)) {
      markTarget();
    }
  });

  parser.on("closetag", () => {
    const currentChildCount = childCounts[childCounts.length - 1];
    const currentPath = elementPath;
    if (elementScheme?.type === "positional") {
      const depthIndex = currentPath.length;
      if (depthIndex <= elementScheme.steps.length &&
          matchesPath(currentPath, elementScheme.steps.slice(0, depthIndex))) {
        positionalCounts[depthIndex] = currentChildCount;
      }
    }
    if (elementScheme?.type === "id" && idAnchorFound && idAnchorPath) {
      const depthIndex = currentPath.length;
      if (matchesPath(currentPath, idAnchorPath)) {
        idCounts[0] = currentChildCount;
      } else if (depthIndex > idAnchorPath.length) {
        const relativePath = currentPath.slice(idAnchorPath.length);
        if (relativePath.length <= elementScheme.steps.length &&
            matchesPath(relativePath, elementScheme.steps.slice(0, relativePath.length))) {
          idCounts[relativePath.length] = currentChildCount;
        }
      }
    }

    if (targetDepth !== null && depth === targetDepth) {
      endPos = parser.position;
      targetDepth = null;
    }
    elementPath.pop();
    childCounts.pop();
    depth -= 1;
  });

  parser.write(xmlSource).close();

  if (startPos === -1 || endPos === -1) {
    const formatStepError = (step: number, requested: number, available: number, anchor?: string) => {
      const anchorInfo = anchor ? ` after anchor "${anchor}"` : "";
      return `XInclude xpointer element() step ${step} out of range${anchorInfo}: requested ${requested}, found ${available} child elements.`;
    };

    if (elementScheme?.type === "positional") {
      if (elementScheme.steps[0] > childCounts[0]) {
        throw new Error(formatStepError(1, elementScheme.steps[0], childCounts[0]));
      }
      for (let i = 1; i < elementScheme.steps.length; i += 1) {
        const available = positionalCounts[i];
        if (available !== undefined && available < elementScheme.steps[i]) {
          throw new Error(formatStepError(i + 1, elementScheme.steps[i], available));
        }
      }
      throw new Error(`XInclude xpointer target not found: ${elementScheme.steps.join("/")}`);
    }

    if (elementScheme?.type === "id") {
      if (!idAnchorFound) {
        throw new Error(`XInclude xpointer target not found: ${elementScheme.id}`);
      }
      if (elementScheme.steps.length > 0 && idCounts[0] !== undefined && idCounts[0] < elementScheme.steps[0]) {
        throw new Error(formatStepError(1, elementScheme.steps[0], idCounts[0], elementScheme.id));
      }
      for (let i = 1; i < elementScheme.steps.length; i += 1) {
        const available = idCounts[i];
        if (available !== undefined && available < elementScheme.steps[i]) {
          throw new Error(formatStepError(i + 1, elementScheme.steps[i], available, elementScheme.id));
        }
      }
      throw new Error(`XInclude xpointer target not found: ${elementScheme.id}`);
    }

    throw new Error(`XInclude xpointer target not found: ${targetId}`);
  }

  return xmlSource.substring(startPos, endPos);
}

function iriToUri(iri: string): string {
  let encoded = "";
  for (const char of iri) {
    const code = char.charCodeAt(0);
    encoded += code <= 0x7f ? char : encodeURIComponent(char);
  }
  return encoded;
}

function resolveXIncludeHref(href: string, baseUri?: Uri): string {
  const hrefUri = iriToUri(href);
  try {
    return new URL(hrefUri).toString();
  } catch (error) {
    // Not an absolute URL, resolve below.
  }

  if (baseUri) {
    try {
      return new URL(hrefUri, baseUri.toString()).toString();
    } catch (error) {
      // Fall back to legacy resolution.
    }
  }

  return normalizeSchemaUrl(href);
}

export async function resolveXIncludes(xmlSource: string, depth = 0, baseUri?: Uri): Promise<string> {
  const resolverParser = new SaxesParser({ xmlns: true, position: true });
  const outputParts: (string | Promise<string>)[] = [];
  
  let lastPos = 0;
  let foundXi = false;

  resolverParser.on("opentag", (node: SaxesTag) => {
    if (node.uri === XINCLUDE_NS && node.local === XINCLUDE_LOCAL) {
      foundXi = true;
      const depthLimit = workspace.getConfiguration("sxml").get("xincludeDepth") as number || 50;
      if (depth < depthLimit) {
        // Find the start of the tag by searching backwards from the parser’s current position.
        // The parser’s position is at the character after the ">" of the opening tag.
        const tagStartPosition = xmlSource.lastIndexOf("<", resolverParser.position - 1);
        
        if (tagStartPosition === -1) {
          // This should not happen in well-formed XML. We"ll log an error and continue.
          console.error("Could not find start of xi:include tag.");
          return;
        }

        // Push the XML content that came before this xi:include tag.
        outputParts.push(xmlSource.substring(lastPos, tagStartPosition));

        // If the tag is self-closing, we update lastPos now. Otherwise, the "closetag"
        // handler will update it to the position after the closing tag.
        if (node.isSelfClosing) {
          lastPos = resolverParser.position;
        }

        // if the xinclude should just return a warning, we do that instead of resolving it.
        // TODO: this will return the setting value at the first time it is called and
        // will not show changes to the config without restarting VSCode. There is an config change event, but how to trickle down to here?
        if (workspace.getConfiguration("sxml").get("xincludeSupport") === false) {
          const line = resolverParser.line;
          const col = resolverParser.column;
          const warningPI = `<?xml-xi-map-enter warning="XInclude resolution is turned off in settings." parent-line="${line}" parent-col="${col}"?><?xml-xi-map-leave?>`;
          outputParts.push(warningPI);
          return;
        }

        const parseAttr = node.attributes.parse as SaxesAttributeNS | undefined;
        const parseMode = parseAttr?.value ?? "xml";
        if (parseMode !== "xml") {
          const errPI = `<?xml-xi-error err="Unsupported XInclude parse value: ${parseMode}" parent-start="${resolverParser.position}" parent-col="${resolverParser.column}"?>`;
          outputParts.push(errPI);
          return;
        }

        const hrefAttr = node.attributes.href as SaxesAttributeNS | undefined;
        const xpointerAttr = node.attributes.xpointer as SaxesAttributeNS | undefined;
        if (hrefAttr) {
          const href = hrefAttr.value;
          const hrefURL = resolveXIncludeHref(href, baseUri);
          const includeUri = Uri.parse(hrefURL);
          const line = resolverParser.line;
          const col = resolverParser.column;
          const makePI = (resolvedNestedXml: string) => {
            // Wrap the resolved content in our source map PIs

            // But only if it’s in the top-level document.
            if (depth > 0) {
              const piNestedEnter = `<?xml-xi-nested-enter uri="${hrefURL}"?>`;
              const piNestedLeave = `<?xml-xi-nested-leave?>`;
              return `${piNestedEnter}${resolvedNestedXml}${piNestedLeave}`;
            };

            const piEnter = `<?xml-xi-map-enter uri="${hrefURL}" parent-line="${line}" parent-col="${col}"?>`;
            const piLeave = `<?xml-xi-map-leave?>`;
            return `${piEnter}${resolvedNestedXml}${piLeave}`;
          }
          const handleErr = (err: Error) => {
            return `<?xml-xi-error err="${err}" parent-start="${resolverParser.position}" parent-col="${col}"?>`;
          }
          let includedContentPromise: Promise<string>;
          if (includeUri.scheme === "http" || includeUri.scheme === "https") {
            // If the href is a URL, we fetch the content.
            includedContentPromise = fetch(hrefURL)
              .then(response => {
                if (!response.ok) {
                  throw new Error(`Failed to fetch ${hrefURL}: ${response.statusText}`);
                }
                return response.text();
              })
              .then(async (doc) => {
                let text = doc.replace(/^\s*<\?xml.*?\?>\s*/, "");
                if (xpointerAttr?.value) {
                  text = selectXPointerFragment(text, xpointerAttr.value);
                }
                return await resolveXIncludes(text, depth + 1, includeUri);
              })
              .then(makePI).catch(handleErr)
          } else {
            includedContentPromise = (workspace.openTextDocument(includeUri)
              .then(async (doc) => {
                let text = doc.getText().replace(/^\s*<\?xml.*?\?>\s*/, "");
                if (xpointerAttr?.value) {
                  text = selectXPointerFragment(text, xpointerAttr.value);
                }
                return await resolveXIncludes(text, depth + 1, doc.uri);
              })
              .then(makePI) as Promise<string>).catch(handleErr);
          }
          outputParts.push(includedContentPromise);
        }

        
      } else {
        // Too deep, just skip the include and continue.
        window.showInformationMessage("Maximum XInclude depth reached, skipping further includes.");
      }
    }
  });

  resolverParser.on("closetag", (node: SaxesTag) => {
    if (node.uri === XINCLUDE_NS && node.local === XINCLUDE_LOCAL) {
      if (depth === 0) {
        // This handles the case for a non-self-closing <xi:include>...</xi:include>
        lastPos = resolverParser.position;
      }
    }
  });

  try {
    // Run the parser over the source XML.
    resolverParser.write(xmlSource).close();
  } catch (err) {
    // if it is deeper, stop including.
    // if the document with xi:includes is not well-formed, we cannot resolve includes.
    if (depth > 0 || !foundXi) {
      return xmlSource;
    }
  }

  // Append any remaining text after the last xi:include.
  outputParts.push(xmlSource.substring(lastPos));

  // Wait for all file I/O and recursive calls to complete, then join the parts.
  const resolvedParts = await Promise.all(outputParts);
  return resolvedParts.join("");
}
