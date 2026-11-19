// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/guest_module_error.ts
var MalformedGuestModule = class extends Error {
  constructor(message) {
    super(message);
    this.name = "MalformedGuestModule";
  }
};

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/wasm_link_metadata.ts
var FATAL_UTF8 = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true
});
var NonUtf8Name = class extends MalformedGuestModule {
  lossy;
  constructor(lossy) {
    super(`name is not valid UTF-8: ${lossy}`), this.lossy = lossy;
    this.name = "NonUtf8Name";
  }
};
var WasmCursor = class _WasmCursor {
  bytes;
  pos;
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  eof() {
    return this.pos >= this.bytes.length;
  }
  byte() {
    if (this.pos >= this.bytes.length) {
      throw new MalformedGuestModule("unexpected eof");
    }
    return this.bytes[this.pos++];
  }
  varuint() {
    let result = 0;
    let shift = 0;
    for (; ; ) {
      const b = this.byte();
      result |= (b & 127) << shift;
      if ((b & 128) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new MalformedGuestModule("uleb too large");
    }
  }
  /**
   * A canonical-width u32 LEB128: at most five bytes, the fifth carrying only
   * the top four bits. `varuint` is looser (it folds a sixth byte into the
   * value); metadata the kernel must read exactly as Wasmtime's
   * `read_uleb128_u32` does (dylink.0) uses this one.
   */
  u32() {
    let result = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const b = this.byte();
      if (shift === 28 && (b & 240) !== 0) {
        throw new MalformedGuestModule("uleb too large");
      }
      result |= (b & 127) << shift;
      if ((b & 128) === 0) return result >>> 0;
    }
    throw new MalformedGuestModule("uleb too large");
  }
  /** A length-prefixed string whose length is read with `u32`. */
  strictString() {
    const len = this.u32();
    const start = this.pos;
    this.skip(len);
    return new TextDecoder().decode(this.bytes.subarray(start, this.pos));
  }
  /**
   * Known divergence (D9, #4634): musl opens a DT_NEEDED name as bytes; here
   * a NEEDED name must be UTF-8 because plan paths and registry keys are JS
   * strings, until K0-S M2b's byte-preserving resolver (#4248).
   *
   * A `strictString` whose bytes must be valid UTF-8, as the wasm tool
   * conventions require of a name (#3939 D9). A malformed name is a malformed
   * module ({@link NonUtf8Name}, ENOEXEC), never decoded lossily.
   */
  strictUtf8String() {
    const len = this.u32();
    const start = this.pos;
    this.skip(len);
    const bytes = this.bytes.subarray(start, this.pos);
    try {
      return FATAL_UTF8.decode(bytes);
    } catch {
      throw new NonUtf8Name(new TextDecoder().decode(bytes));
    }
  }
  varint(maxShift = 35) {
    let shift = 0;
    for (; ; ) {
      const b = this.byte();
      if ((b & 128) === 0) return;
      shift += 7;
      if (shift > maxShift) throw new MalformedGuestModule("sleb too large");
    }
  }
  string() {
    const len = this.varuint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.bytes.length) {
      throw new MalformedGuestModule("string out of bounds");
    }
    return new TextDecoder().decode(this.bytes.subarray(start, this.pos));
  }
  skip(n) {
    this.pos += n;
    if (this.pos > this.bytes.length) {
      throw new MalformedGuestModule("skip out of bounds");
    }
  }
  sub(len) {
    const start = this.pos;
    this.skip(len);
    return new _WasmCursor(this.bytes.subarray(start, start + len));
  }
};
function skipConstExpr(cursor, onFunctionRef, onGlobalRef) {
  for (; ; ) {
    const op = cursor.byte();
    if (op === 11) return;
    switch (op) {
      case 65:
      case 66:
        cursor.varuint();
        break;
      case 35: {
        const index = cursor.varuint();
        onGlobalRef?.(index);
        break;
      }
      case 210:
        {
          const index = cursor.varuint();
          onFunctionRef?.(index);
        }
        break;
      case 67:
        cursor.skip(4);
        break;
      case 68:
        cursor.skip(8);
        break;
      case 208:
        cursor.byte();
        break;
      case 209:
        break;
      // The extended-const proposal: i32/i64 add/sub/mul are permitted in
      // const expressions (global initializers, and element/data segment
      // offsets), beyond the const-and-global.get-only MVP baseline. No
      // immediate: these are pure binary stack operations.
      case 106:
      case 107:
      case 108:
      case 124:
      case 125:
      case 126:
        break;
      default:
        throw new MalformedGuestModule(`unsupported const expr opcode ${op}`);
    }
  }
}
function skipValType(cursor) {
  const ty = cursor.byte();
  if (ty === 100 || ty === 99) cursor.varuint();
}
function skipLimits(cursor) {
  const flags = cursor.varuint();
  cursor.varuint();
  if ((flags & 1) !== 0) cursor.varuint();
}
function skipTableType(cursor) {
  skipValType(cursor);
  skipLimits(cursor);
}
function skipGlobalType(cursor) {
  skipValType(cursor);
  cursor.byte();
}
function wasmLinkMetadata(bytes) {
  const cursor = new WasmCursor(bytes);
  cursor.skip(8);
  const types = [];
  const functionTypes = [];
  const globalTypes2 = [];
  let importedGlobals = 0;
  const globalsBasedOnGlobal = /* @__PURE__ */ new Set();
  const imports = [];
  const exports = /* @__PURE__ */ new Map();
  while (!cursor.eof()) {
    const sectionId = cursor.byte();
    const section = cursor.sub(cursor.varuint());
    if (sectionId === 1) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        if (section.byte() !== 96) {
          throw new MalformedGuestModule("non-function type");
        }
        const params = Array.from({
          length: section.varuint()
        }, () => section.byte());
        const results = Array.from({
          length: section.varuint()
        }, () => section.byte());
        types.push(`${params.join(",")}->${results.join(",")}`);
      }
      continue;
    }
    if (sectionId === 2) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        const module = section.string();
        const name = section.string();
        const kind = section.byte();
        if (kind === 0) {
          const typeIndex = section.varuint();
          functionTypes.push(typeIndex);
          imports.push({
            module,
            name,
            kind: "function",
            type: types[typeIndex]
          });
        } else if (kind === 1) {
          skipTableType(section);
          imports.push({
            module,
            name,
            kind: "table"
          });
        } else if (kind === 2) {
          skipLimits(section);
          imports.push({
            module,
            name,
            kind: "memory"
          });
        } else if (kind === 3) {
          const valueType = section.byte();
          const mutable = section.byte();
          const type = `${valueType}:${mutable}`;
          globalTypes2.push(type);
          importedGlobals++;
          imports.push({
            module,
            name,
            kind: "global",
            type
          });
        } else if (kind === 4) {
          section.byte();
          const typeIndex = section.varuint();
          imports.push({
            module,
            name,
            kind: "tag",
            type: types[typeIndex]
          });
        } else {
          throw new MalformedGuestModule(`unknown import kind ${kind}`);
        }
      }
      continue;
    }
    if (sectionId === 3) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) functionTypes.push(section.varuint());
      continue;
    }
    if (sectionId === 6) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        const valueType = section.byte();
        const mutable = section.byte();
        globalTypes2.push(`${valueType}:${mutable}`);
        skipConstExpr(section, void 0, () => {
          globalsBasedOnGlobal.add(globalTypes2.length - 1);
        });
      }
      continue;
    }
    if (sectionId === 7) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        const name = section.string();
        const kind = section.byte();
        const index = section.varuint();
        if (kind === 0) {
          exports.set(name, {
            kind: "function",
            type: types[functionTypes[index]]
          });
        } else if (kind === 1) {
          exports.set(name, {
            kind: "table"
          });
        } else if (kind === 2) {
          exports.set(name, {
            kind: "memory"
          });
        } else if (kind === 3) {
          exports.set(name, {
            kind: "global",
            type: globalTypes2[index],
            imported: index < importedGlobals,
            basedOnGlobal: globalsBasedOnGlobal.has(index)
          });
        } else if (kind === 4) {
          exports.set(name, {
            kind: "tag"
          });
        }
      }
    }
  }
  return {
    imports,
    exports
  };
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/wasm_section_pieces.ts
function ulebBytes(value) {
  const out = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value !== 0) byte |= 128;
    out.push(byte);
  } while (value !== 0);
  return new Uint8Array(out);
}
function ulebLength(value) {
  let length = 1;
  while (value >= 128) {
    value >>>= 7;
    length++;
  }
  return length;
}
function payloadLength(section) {
  let length = 0;
  for (const piece of section.pieces) length += piece.byteLength;
  return length;
}
function sectionPayload(section) {
  if (section.pieces.length === 1) return section.pieces[0];
  const out = new Uint8Array(payloadLength(section));
  let at = 0;
  for (const piece of section.pieces) {
    out.set(piece, at);
    at += piece.byteLength;
  }
  return out;
}
function encodedLength(header, sections) {
  let length = header.byteLength;
  for (const section of sections) {
    const size = payloadLength(section);
    length += 1 + ulebLength(size) + size;
  }
  return length;
}
function writeSections(header, sections, into) {
  const length = encodedLength(header, sections);
  const out = into !== void 0 && into.byteLength >= length ? into.subarray(0, length) : new Uint8Array(length);
  out.set(header, 0);
  let at = header.byteLength;
  for (const section of sections) {
    out[at++] = section.id;
    let size = payloadLength(section);
    do {
      let byte = size & 127;
      size >>>= 7;
      if (size !== 0) byte |= 128;
      out[at++] = byte;
    } while (size !== 0);
    for (const piece of section.pieces) {
      out.set(piece, at);
      at += piece.byteLength;
    }
  }
  return out;
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/wasm_code_immediates.ts
function skipBlockType(cursor) {
  cursor.varint();
}
function skipMemArg(cursor) {
  cursor.varuint();
  cursor.varuint();
}
var SIMD_SHAPES = [
  [
    0,
    11,
    "mem"
  ],
  [
    12,
    13,
    "v128"
  ],
  [
    14,
    20,
    "none"
  ],
  [
    21,
    34,
    "lane"
  ],
  [
    35,
    83,
    "none"
  ],
  [
    84,
    91,
    "memlane"
  ],
  [
    92,
    93,
    "mem"
  ],
  [
    94,
    153,
    "none"
  ],
  [
    155,
    159,
    "none"
  ],
  [
    160,
    161,
    "none"
  ],
  [
    163,
    164,
    "none"
  ],
  [
    167,
    174,
    "none"
  ],
  [
    177,
    177,
    "none"
  ],
  [
    181,
    186,
    "none"
  ],
  [
    188,
    193,
    "none"
  ],
  [
    195,
    196,
    "none"
  ],
  [
    199,
    206,
    "none"
  ],
  [
    209,
    209,
    "none"
  ],
  [
    213,
    225,
    "none"
  ],
  [
    227,
    237,
    "none"
  ],
  [
    239,
    255,
    "none"
  ],
  [
    256,
    275,
    "none"
  ]
];
function skipSimdImmediate(cursor, subop) {
  const shape = SIMD_SHAPES.find(([lo, hi]) => subop >= lo && subop <= hi)?.[2];
  switch (shape) {
    case "mem":
      skipMemArg(cursor);
      return;
    case "v128":
      cursor.skip(16);
      return;
    case "lane":
      cursor.byte();
      return;
    case "memlane":
      skipMemArg(cursor);
      cursor.byte();
      return;
    case "none":
      return;
    default:
      throw new MalformedGuestModule(`unsupported 0xfd opcode ${subop}`);
  }
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/startup_wasm.ts
function scanStartBody(code) {
  const admission = {};
  const cursor = new WasmCursor(code);
  const refuse2 = (what) => {
    if (admission.violation === void 0) {
      admission.violation = what;
    }
  };
  const localDecls = cursor.varuint();
  for (let i = 0; i < localDecls; i++) {
    cursor.varuint();
    skipValType(cursor);
  }
  let controlDepth = 1;
  while (!cursor.eof()) {
    const instrStart = cursor.pos;
    const op = cursor.byte();
    switch (op) {
      case 11:
        controlDepth--;
        if (controlDepth === 0) {
          if (!cursor.eof()) {
            throw new MalformedGuestModule("trailing code after function end");
          }
          return admission;
        }
        break;
      case 38:
        cursor.varuint();
        break;
      case 252: {
        const subop = cursor.varuint();
        if (subop <= 7) {
        } else if ([
          8,
          10,
          12,
          14
        ].includes(subop)) {
          cursor.varuint();
          cursor.varuint();
        } else if ([
          9,
          11,
          13,
          15,
          16,
          17
        ].includes(subop)) {
          cursor.varuint();
          if (subop === 15) refuse2("table.grow");
        } else {
          throw new MalformedGuestModule(`unsupported 0xfc opcode ${subop}`);
        }
        break;
      }
      case 253: {
        const subop = cursor.varuint();
        skipSimdImmediate(cursor, subop);
        break;
      }
      case 254: {
        const subop = cursor.varuint();
        if (subop === 3) {
          cursor.byte();
        } else if (subop <= 2 || subop >= 16 && subop <= 78) {
          skipMemArg(cursor);
          if (subop === 1 || subop === 2) {
            (admission.waits ??= []).push([
              instrStart,
              cursor.pos
            ]);
          }
        } else {
          throw new MalformedGuestModule(`unsupported 0xfe opcode ${subop}`);
        }
        break;
      }
      case 2:
      case 3:
      case 4: {
        skipBlockType(cursor);
        controlDepth++;
        break;
      }
      case 31: {
        skipBlockType(cursor);
        const catchCount = cursor.varuint();
        for (let i = 0; i < catchCount; i++) {
          switch (cursor.byte()) {
            case 0:
            case 1:
              cursor.varuint();
              cursor.varuint();
              break;
            case 2:
            case 3:
              cursor.varuint();
              break;
            default:
              throw new MalformedGuestModule("unsupported try_table catch kind");
          }
        }
        controlDepth++;
        break;
      }
      case 5:
        break;
      // Legacy exception handling, which clang's -fwasm-exceptions emits (#3476).
      case 6:
        skipBlockType(cursor);
        controlDepth++;
        break;
      case 7:
        cursor.varuint();
        break;
      case 9:
        cursor.varuint();
        break;
      case 24:
        cursor.varuint();
        controlDepth--;
        if (controlDepth <= 0) {
          throw new MalformedGuestModule("delegate without matching try");
        }
        break;
      case 25:
        break;
      case 8:
        cursor.varuint();
        break;
      case 10:
        break;
      case 17:
      case 19:
        cursor.varuint();
        cursor.varuint();
        refuse2(op === 17 ? "call_indirect" : "return_call_indirect");
        break;
      case 28: {
        const count = cursor.varuint();
        for (let i = 0; i < count; i++) skipValType(cursor);
        break;
      }
      case 12:
      case 13:
      case 32:
      case 33:
      case 34:
      case 37:
      case 63:
      case 208:
        cursor.varuint();
        break;
      case 16:
      case 18:
      case 210: {
        cursor.varuint();
        if (op === 16) refuse2("call");
        else if (op === 18) refuse2("return_call");
        break;
      }
      case 20:
      case 21: {
        cursor.varuint();
        refuse2(op === 20 ? "call_ref" : "return_call_ref");
        break;
      }
      case 35: {
        cursor.varuint();
        break;
      }
      case 36: {
        cursor.varuint();
        break;
      }
      case 64:
        cursor.varuint();
        refuse2("memory.grow");
        break;
      case 40:
      case 41:
      case 42:
      case 43:
      case 44:
      case 45:
      case 46:
      case 47:
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
      case 58:
      case 59:
      case 60:
      case 61:
      case 62:
        skipMemArg(cursor);
        break;
      case 65:
        cursor.varint();
        break;
      case 66:
        cursor.varint(70);
        break;
      case 14: {
        const n = cursor.varuint();
        for (let i = 0; i <= n; i++) cursor.varuint();
        break;
      }
      case 67:
        cursor.skip(4);
        break;
      case 68:
        cursor.skip(8);
        break;
      case 0:
      case 1:
      case 15:
      case 26:
      case 27:
      case 209:
        break;
      default:
        if (op >= 69 && op <= 196) break;
        throw new MalformedGuestModule(`unsupported opcode 0x${op.toString(16)}`);
    }
  }
  throw new MalformedGuestModule("missing function end");
}
function validateStartFunctionDoesNoWork(bytes) {
  const cursor = new WasmCursor(bytes);
  if (cursor.byte() !== 0 || cursor.byte() !== 97 || cursor.byte() !== 115 || cursor.byte() !== 109) throw new MalformedGuestModule("bad wasm magic");
  cursor.skip(4);
  let importedFunctions = 0;
  let start;
  while (!cursor.eof()) {
    const sectionId = cursor.byte();
    const section = cursor.sub(cursor.varuint());
    if (sectionId === 2) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        section.string();
        section.string();
        const kind = section.byte();
        if (kind === 0) {
          section.varuint();
          importedFunctions++;
        } else if (kind === 1) {
          section.byte();
          const flags = section.varuint();
          section.varuint();
          if ((flags & 1) !== 0) section.varuint();
        } else if (kind === 2) {
          const flags = section.varuint();
          section.varuint();
          if ((flags & 1) !== 0) section.varuint();
        } else if (kind === 3) {
          section.byte();
          section.byte();
        } else {
          section.varuint();
          section.varuint();
        }
      }
    } else if (sectionId === 8) {
      start = section.varuint();
      if (start < importedFunctions) {
        throw new WebAssembly.CompileError("the module's start function is an imported function; the start function must be defined by the module (#4248)");
      }
    } else if (sectionId === 10) {
      if (start === void 0) return;
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        const body = section.sub(section.varuint()).bytes;
        if (importedFunctions + i !== start) continue;
        const admission = scanStartBody(body);
        if (admission.violation !== void 0) {
          throw new WebAssembly.CompileError(`the module's start function contains ${admission.violation}; a start function may not call or grow memory or a table (#4248)`);
        }
      }
    }
  }
}
function neutraliseStartWaits(bytes) {
  const cursor = new WasmCursor(bytes);
  if (cursor.byte() !== 0 || cursor.byte() !== 97 || cursor.byte() !== 115 || cursor.byte() !== 109) return bytes;
  cursor.skip(4);
  const sections = [];
  while (!cursor.eof()) {
    const id = cursor.byte();
    const size = cursor.varuint();
    sections.push({
      id,
      pieces: [
        cursor.sub(size).bytes
      ]
    });
  }
  const rewritten = neutraliseStartWaitSections(sections);
  return rewritten === void 0 ? bytes : writeSections(bytes.subarray(0, 8), rewritten);
}
function neutraliseStartWaitSections(sections) {
  let importedFunctions = 0;
  let start;
  const definedTypes = [];
  for (const section of sections) {
    const id = section.id;
    if (id !== 2 && id !== 3 && id !== 8) continue;
    const reader = new WasmCursor(sectionPayload(section));
    if (id === 2) {
      const count2 = reader.varuint();
      for (let i = 0; i < count2; i++) {
        reader.string();
        reader.string();
        const kind = reader.byte();
        if (kind === 0) {
          reader.varuint();
          importedFunctions++;
        } else if (kind === 1) {
          reader.byte();
          const flags = reader.varuint();
          reader.varuint();
          if ((flags & 1) !== 0) reader.varuint();
        } else if (kind === 2) {
          const flags = reader.varuint();
          reader.varuint();
          if ((flags & 1) !== 0) reader.varuint();
        } else if (kind === 3) {
          reader.byte();
          reader.byte();
        } else {
          reader.varuint();
          reader.varuint();
        }
      }
    } else if (id === 3) {
      const count2 = reader.varuint();
      for (let i = 0; i < count2; i++) definedTypes.push(reader.varuint());
    } else {
      start = reader.varuint();
    }
  }
  if (start === void 0 || start < importedFunctions) return void 0;
  const ordinal = start - importedFunctions;
  const startType = definedTypes[ordinal];
  const code = sections.find((section) => section.id === 10);
  if (startType === void 0 || code === void 0) return void 0;
  const codeReader = new WasmCursor(sectionPayload(code));
  const count = codeReader.varuint();
  let body;
  for (let i = 0; i < count; i++) {
    const length = codeReader.varuint();
    const entry = codeReader.sub(length).bytes;
    if (i === ordinal) body = entry;
  }
  if (body === void 0) return void 0;
  const admission = scanStartBody(body);
  if (admission.waits === void 0) return void 0;
  const timedOut = [
    26,
    26,
    26,
    65,
    2
  ];
  let copyLength = body.length;
  for (const [from, to] of admission.waits) {
    copyLength += timedOut.length - (to - from);
  }
  const copy = new Uint8Array(copyLength);
  let copied = 0;
  let written = 0;
  for (const [from, to] of admission.waits) {
    copy.set(body.subarray(copied, from), written);
    written += from - copied;
    copy.set(timedOut, written);
    written += timedOut.length;
    copied = to;
  }
  copy.set(body.subarray(copied), written);
  const copyIndex = importedFunctions + definedTypes.length;
  return sections.map((section) => {
    const { id } = section;
    if (id !== 3 && id !== 8 && id !== 10) return section;
    if (id === 8) return {
      id,
      pieces: [
        ulebBytes(copyIndex)
      ]
    };
    const payload = sectionPayload(section);
    const reader = new WasmCursor(payload);
    const n = reader.varuint();
    const rest = payload.subarray(reader.pos);
    return id === 3 ? {
      id,
      pieces: [
        ulebBytes(n + 1),
        rest,
        ulebBytes(startType)
      ]
    } : {
      id,
      pieces: [
        ulebBytes(n + 1),
        rest,
        ulebBytes(copy.length),
        copy
      ]
    };
  });
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/constants.ts
var METHOD = {
  KERNEL_ECHO: 1,
  KERNEL_NOW_REALTIME: 2,
  KERNEL_LOG_TEST: 3,
  KERNEL_PROVIDE_STDIN: 4,
  KERNEL_CLOSE_STDIN: 5,
  KERNEL_DRAIN_STDOUT: 6,
  KERNEL_DRAIN_STDERR: 7,
  KERNEL_REGISTER_FILE: 8,
  KERNEL_INSTALL_TAR_LAYER: 10,
  KERNEL_INSTALL_YURTFS: 12,
  KERNEL_SET_PROCESS_CREDENTIALS: 13,
  KERNEL_STAGE_CHMOD: 70,
  KERNEL_REGISTER_FILE_CHUNK: 14,
  KERNEL_LIST_PROCESSES: 16,
  KERNEL_LIST_PROCESS_FDS: 21,
  KERNEL_CANCEL_FD_READABLE: 22,
  KERNEL_DO_SYSCALL: 23,
  KERNEL_CONTINUE_SYSCALL: 71,
  KERNEL_VFS_INODE_NAMES: 72,
  KERNEL_VFS_LINK: 73,
  KERNEL_INSTALL_HOST_FS_MOUNT_ABS: 24,
  KERNEL_VFS_SET_METADATA: 33,
  KERNEL_LIST_ANON_SHARED_REGIONS: 34,
  KERNEL_STORE_ANON_SHARED_BYTES: 35,
  KERNEL_CANCEL_WAIT: 36,
  KERNEL_INSTALL_MOUNT_TABLE: 37,
  KERNEL_TTY_RUNTIME_ACTION: 41,
  KERNEL_PTY_MASTER_READ: 47,
  KERNEL_PTY_MASTER_WRITE: 48,
  KERNEL_PTY_MASTER_CLOSE: 49,
  KERNEL_PTY_SET_WINSIZE: 50,
  /** Host-held pipe ends for a spawned process's fds 0..2 (#2817). */
  KERNEL_HOST_PIPE_ATTACH: 62,
  KERNEL_HOST_PIPE_WRITE: 63,
  KERNEL_HOST_PIPE_READ: 64,
  KERNEL_HOST_PIPE_CLOSE: 65,
  /** Records the address space a freshly installed image can hold. */
  KERNEL_SET_IMAGE_ADDRESS_SPACE: 66,
  /** Host-only: the guest's own RLIMIT_AS soft, unclipped by the image. */
  KERNEL_GET_GUEST_RLIMIT_AS: 69,
  /** Host-only: whether the startup loader runs in musl secure mode. */
  KERNEL_STARTUP_LOADER_POLICY: 74,
  /** Host-only (#4851 D2): a module's constructed marker ran on the caller. */
  KERNEL_MODULE_CONSTRUCTED: 75,
  KERNEL_HOST_CALL_DRAIN: 54,
  KERNEL_HOST_CALL_COMPLETE: 55,
  /** Kernel-owned executable load transaction; action 4 streams a staged
   * exec/spawn's owned image, action 5 is the capture preflight (#3553). */
  KERNEL_READ_EXECUTABLE: 56,
  /** Internal Worker-host relay: fetch a runtime side-module byte image. */
  WORKER_RUNTIME_DLOPEN: 135169,
  WORKER_RUNTIME_LINK_PLAN: 135170,
  WORKER_RUNTIME_LINK_PUBLISH: 135171,
  WORKER_RUNTIME_LINK_RETIRE: 135172,
  WORKER_RUNTIME_LINK_RETAIN: 135173,
  WORKER_RUNTIME_LINK_RESERVE: 135174,
  WORKER_RUNTIME_LINK_ABORT: 135175,
  WORKER_RUNTIME_LINK_SYMBOL: 135176,
  WORKER_RUNTIME_LINK_PROMOTE: 135177,
  /** Chunked upload of a fresh record's bytes (#4015): begin returns an id. */
  WORKER_RUNTIME_LINK_UPLOAD_BEGIN: 135178,
  WORKER_RUNTIME_LINK_UPLOAD_CHUNK: 135179,
  WORKER_RUNTIME_LINK_UPLOAD_ABORT: 135180,
  /** Chunked read of a published record's bytes, keyed by (path, generation). */
  WORKER_RUNTIME_LINK_BYTES_GET: 135181,
  /** Operation-owned module inputs (#4015 slice 2): stage a VFS file the lane
   *  cannot carry, read it in chunks, release it. */
  WORKER_RUNTIME_LINK_INPUT_STAGE: 135182,
  WORKER_RUNTIME_LINK_INPUT_GET: 135183,
  WORKER_RUNTIME_LINK_INPUT_RELEASE: 135184,
  // Live host-to-kernel operations. Guest Linux syscalls use the raw
  // KERNEL_DO_SYSCALL conduit and are not represented by this list.
  SYS_GETPID: 65541,
  KERNEL_FS_CHDIR: 65546,
  KERNEL_FS_GETCWD: 65547,
  SYS_GETRLIMIT: 65548,
  SYS_SETRLIMIT: 65549,
  KERNEL_FS_CLOSE: 65550,
  SYS_EXTENSION_INVOKE: 65552,
  KERNEL_FS_READ: 65555,
  SYS_READ: 65555,
  SYS_WRITE: 65556,
  SYS_CLOCK_GETTIME: 65558,
  SYS_GETPGID: 65559,
  SYS_SETPGID: 65560,
  SYS_GETSID: 65561,
  SYS_KILL: 65563,
  SYS_KILLPG: 65619,
  SYS_TGKILL: 65770,
  SYS_SIGACTION: 65564,
  SYS_SIGPROCMASK: 65739,
  SYS_SETDOMAINNAME: 65785,
  SYS_UMOUNT: 65798,
  SYS_UMOUNT2: 65799,
  SYS_OPEN_TREE: 65810,
  SYS_MOVE_MOUNT: 65811,
  SYS_PAUSE: 65760,
  SYS_SIGWAIT: 65780,
  SYS_SCHED_YIELD: 65565,
  SYS_NANOSLEEP: 65566,
  KERNEL_FS_OPEN: 65567,
  SYS_OPEN: 65567,
  SYS_GETRESUID: 65994,
  SYS_GETRESGID: 65995,
  KERNEL_FS_FSTAT: 65569,
  KERNEL_FS_CHMOD: 65570,
  // lstat is in the B2 fd/vfs id block (0x1_0070–0x1_007F), grouped
  // here next to stat for readability — see the method-id partition
  // in abi/contract/yurt_abi_methods.toml. Issue #81.
  // POSIX AIO (#846): aio_read/write/fsync submit, aio_error poll, aio_return.
  SYS_AIO_SUBMIT: 65989,
  SYS_AIO_POLL: 65990,
  SYS_AIO_RESULT: 65991,
  SYS_AIO_CANCEL: 65992,
  KERNEL_FS_SYMLINK: 65575,
  KERNEL_FS_MKDIR: 65577,
  SYS_WAIT: 65580,
  SYS_SPAWN: 65583,
  SYS_FETCH: 65584,
  SYS_SOCKET_CONNECT: 65585,
  SYS_SOCKET_SEND: 65586,
  SYS_SOCKET_RECV: 65587,
  SYS_SOCKET_CLOSE: 65588,
  SYS_SOCKET_LISTEN: 65593,
  SYS_SOCKET_ACCEPT: 65594,
  SYS_POLL: 65603,
  SYS_MMAP_PREPARE: 65728,
  SYS_MMAP_COMMIT: 65729,
  SYS_MMAP_ABORT: 65730,
  SYS_MUNMAP: 65731,
  SYS_GETITIMER: 65858,
  SYS_SETITIMER: 65859,
  SYS_TIMER_CREATE: 65860,
  SYS_TIMER_SETTIME: 65861,
  SYS_TIMER_GETTIME: 65862,
  SYS_TIMER_DELETE: 65863,
  SYS_TIMER_GETOVERRUN: 65864,
  SYS_SOCKET_OPEN: 65605,
  SYS_SOCKET_BIND: 65606,
  // B3 sockets/network block (0x1_0080–0x1_008F). Must match the Rust
  // codegen id in abi/contract/yurt_abi_methods.toml [method.sys_socket_peercred].
  SYS_THREAD_SELF: 65614,
  SYS_THREAD_JOIN: 65615,
  SYS_THREAD_YIELD: 65618,
  SYS_THREAD: 66019,
  // [method.sys_signal_poll]: the guest libc's post-syscall signal poll.
  SYS_SIGNAL_POLL: 65742,
  SYS_SHARED_MUTEX_LOCK: 65771
};
function isWorkerRuntimeLinkMethod(method) {
  return method === METHOD.WORKER_RUNTIME_DLOPEN || method === METHOD.WORKER_RUNTIME_LINK_PLAN || method === METHOD.WORKER_RUNTIME_LINK_RESERVE || method === METHOD.WORKER_RUNTIME_LINK_ABORT || method === METHOD.WORKER_RUNTIME_LINK_SYMBOL || method === METHOD.WORKER_RUNTIME_LINK_PUBLISH || method === METHOD.WORKER_RUNTIME_LINK_RETAIN || method === METHOD.WORKER_RUNTIME_LINK_PROMOTE || method === METHOD.WORKER_RUNTIME_LINK_RETIRE || method === METHOD.WORKER_RUNTIME_LINK_UPLOAD_BEGIN || method === METHOD.WORKER_RUNTIME_LINK_UPLOAD_CHUNK || method === METHOD.WORKER_RUNTIME_LINK_UPLOAD_ABORT || method === METHOD.WORKER_RUNTIME_LINK_BYTES_GET || method === METHOD.WORKER_RUNTIME_LINK_INPUT_STAGE || method === METHOD.WORKER_RUNTIME_LINK_INPUT_GET || method === METHOD.WORKER_RUNTIME_LINK_INPUT_RELEASE;
}
var LINUX_NR_WRITE = 1;
var LINUX_NR_MMAP = 9;
var LINUX_NR_EXIT_GROUP = 231;
var MAX_AUXV_ENTRIES = 32;
function auxvValid(auxv) {
  if (auxv.length > MAX_AUXV_ENTRIES) return false;
  const isU32 = (n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 4294967295;
  const tags = /* @__PURE__ */ new Set();
  for (let index = 0; index < auxv.length; index++) {
    const entry = auxv[index];
    if (typeof entry !== "object" || entry === null) return false;
    const { tag, value } = entry;
    if (!isU32(tag) || !isU32(value) || tag === 0) return false;
    if (tags.has(tag)) return false;
    tags.add(tag);
  }
  return true;
}
var ENOENT = 2;
var ENOTDIR = 20;
var ENAMETOOLONG = 36;
var EINTR = 4;
var EAGAIN = 11;
var EFAULT = 14;
var EACCES = 13;
var EBADF = 9;
var EINVAL = 22;
var E2BIG = 7;
var EIO = 5;
var ENOMEM = 12;
var ENOEXEC = 8;
var WAIT_PARKED = -2147483648;
var PROCESS_EXITED_BASE = -2147418112;
var PROCESS_EXITED_MAX = PROCESS_EXITED_BASE + 255;
var HOST_CALL_PENDING = -2147417853n;
var SYSCALL_REDISPATCH = -2147417850;
var MACHINE_HALTED_BASE = PROCESS_EXITED_BASE - 256;
var MACHINE_HALTED_MAX = MACHINE_HALTED_BASE + 255;
var PROCESS_SIGNALED_BASE = MACHINE_HALTED_BASE - 128;
var PROCESS_SIGNALED_MAX = PROCESS_SIGNALED_BASE + 127;
var PROCESS_COMPLETION_SIGNALED_MIN = -(128 + 64);
var PROCESS_COMPLETION_SIGNALED_MAX = -(128 + 1);
var PROCESS_COMPLETION_SIGNALED_CORE_MIN = -(256 + 64);
var PROCESS_COMPLETION_SIGNALED_CORE_MAX = -(256 + 1);
function machineHaltedStatus(rc) {
  return rc >= MACHINE_HALTED_BASE && rc <= MACHINE_HALTED_MAX ? rc - MACHINE_HALTED_BASE : void 0;
}
function processExitedStatus(rc) {
  return rc >= PROCESS_EXITED_BASE && rc <= PROCESS_EXITED_MAX ? rc - PROCESS_EXITED_BASE : void 0;
}
function processSignaledStatus(rc) {
  if (rc < PROCESS_SIGNALED_BASE || rc > PROCESS_SIGNALED_MAX) return void 0;
  const encoded = rc - PROCESS_SIGNALED_BASE;
  return {
    signal: (encoded & 63) + 1,
    core: (encoded & 64) !== 0
  };
}
var FORK_PENDING = -2147417854;
var FORK_CONTINUATION_SIZE = 16;
function decodeForkContinuation(response) {
  if (response.byteLength < FORK_CONTINUATION_SIZE) return null;
  const view = new DataView(response.buffer, response.byteOffset, FORK_CONTINUATION_SIZE);
  const mode = view.getUint32(0, true);
  const hasStack = view.getUint32(4, true);
  const stack = view.getUint32(8, true);
  const reserved = view.getUint32(12, true);
  if (reserved !== 0 || mode !== 1 && mode !== 2 && mode !== 3) return null;
  if (hasStack === 0 && stack !== 0 || hasStack !== 0 && hasStack !== 1) {
    return null;
  }
  return {
    mode: mode === 1 ? "fork" : mode === 2 ? "vfork" : "vfork_shared",
    ...hasStack === 1 ? {
      childStackTop: stack
    } : {}
  };
}
var THREAD_EXIT_PREPARE_BASE = -12884901888;
var THREAD_EXIT_PREPARE_MAX = THREAD_EXIT_PREPARE_BASE + 4294967295;
var PROCESS_EXIT_PREPARE_BASE = -17179869184;
var PROCESS_EXIT_PREPARE_MAX = PROCESS_EXIT_PREPARE_BASE + 4294967295;
var THREAD_EXITED_BASE = -8589934592;
var THREAD_EXITED_MAX = THREAD_EXITED_BASE + 4294967295;
var YURT_THREAD_CREATE = 0;
function threadExitedValue(rc) {
  return rc >= THREAD_EXITED_BASE && rc <= THREAD_EXITED_MAX ? rc - THREAD_EXITED_BASE : void 0;
}
function exitPreparationCookie(rc, base, max) {
  return rc >= base && rc <= max ? rc - base : void 0;
}
var KH_CONNECT_ASYNC = 1 << 30;
var MAX_GUEST_BUFFER_LEN = 1024 * 1024;
var AIO_MAX_WRITE_TRANSFER_LEN = MAX_GUEST_BUFFER_LEN - 28;
var AIO_MAX_READ_TRANSFER_LEN = MAX_GUEST_BUFFER_LEN - 56;
var MAX_MODULE_BYTES = 64 * 1024 * 1024;
var CHILD_TRAP_EXIT = 134;
var I64_RESULT_GUEST_IMPORTS = /* @__PURE__ */ new Set([
  "syscall",
  "syscall_fork_family"
]);
function unimplementedGuestImportResult(name, enosys) {
  return I64_RESULT_GUEST_IMPORTS.has(name) ? BigInt(-enosys) : -enosys;
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/wasm_types.ts
function readValTypeKey(cursor) {
  const ty = cursor.byte();
  return ty === 99 || ty === 100 ? `${ty}:${cursor.varuint()}` : `${ty}`;
}
function readFunctionType(cursor) {
  if (cursor.byte() !== 96) return void 0;
  const params = Array.from({
    length: cursor.varuint()
  }, () => readValTypeKey(cursor));
  const results = Array.from({
    length: cursor.varuint()
  }, () => readValTypeKey(cursor));
  return `${params.join(",")}->${results.join(",")}`;
}
function skipLimits2(cursor) {
  const flags = cursor.varuint();
  cursor.varuint();
  if (flags & 1) cursor.varuint();
}
function indexFunctionTypes(bytes, importsOnly = false) {
  const index = {
    types: [],
    imports: /* @__PURE__ */ new Map(),
    exports: /* @__PURE__ */ new Map(),
    functionTypes: []
  };
  const cursor = new WasmCursor(bytes);
  cursor.skip(8);
  while (!cursor.eof()) {
    const id = cursor.byte();
    if (importsOnly && id > 2 && id !== 0) break;
    const section = cursor.sub(cursor.varuint());
    if (id === 1) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        const type = readFunctionType(section);
        if (type === void 0) break;
        index.types.push(type);
      }
    } else if (id === 2) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        const module = section.string();
        const name = section.string();
        const kind = section.byte();
        if (kind === 0) {
          const type = section.varuint();
          const key2 = `${module}\0${name}`;
          const prior = index.imports.get(key2);
          index.imports.set(key2, prior === void 0 || index.types[prior] === index.types[type] ? type : -1);
          index.functionTypes.push(type);
        } else if (kind === 1) {
          readValTypeKey(section);
          skipLimits2(section);
        } else if (kind === 2) {
          skipLimits2(section);
        } else if (kind === 3) {
          readValTypeKey(section);
          section.byte();
        } else if (kind === 4) {
          section.byte();
          section.varuint();
        } else {
          throw new Error(`unsupported import kind ${kind}`);
        }
      }
    } else if (id === 3) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        index.functionTypes.push(section.varuint());
      }
    } else if (id === 7) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        const name = section.string();
        const kind = section.byte();
        const at = section.varuint();
        if (kind === 0) index.exports.set(name, at);
      }
    }
  }
  return index;
}
var indexes = /* @__PURE__ */ new WeakMap();
function functionTypeIndex(bytes) {
  let index = indexes.get(bytes);
  if (!index) {
    index = indexFunctionTypes(bytes);
    indexes.set(bytes, index);
  }
  return index;
}
function exportFunctionType(bytes, name) {
  const index = functionTypeIndex(bytes);
  const fn = index.exports.get(name);
  if (fn === void 0) return void 0;
  const type = index.functionTypes[fn];
  return type === void 0 ? void 0 : index.types[type];
}

// ../../../../.cache/deno/npm/registry.npmjs.org/hash-wasm/4.12.0/dist/index.esm.js
function __awaiter(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}
var Mutex = class {
  constructor() {
    this.mutex = Promise.resolve();
  }
  lock() {
    let begin = () => {
    };
    this.mutex = this.mutex.then(() => new Promise(begin));
    return new Promise((res) => {
      begin = res;
    });
  }
  dispatch(fn) {
    return __awaiter(this, void 0, void 0, function* () {
      const unlock = yield this.lock();
      try {
        return yield Promise.resolve(fn());
      } finally {
        unlock();
      }
    });
  }
};
var _a;
function getGlobal() {
  if (typeof globalThis !== "undefined") return globalThis;
  if (typeof self !== "undefined") return self;
  if (typeof window !== "undefined") return window;
  return global;
}
var globalObject = getGlobal();
var nodeBuffer = (_a = globalObject.Buffer) !== null && _a !== void 0 ? _a : null;
var textEncoder = globalObject.TextEncoder ? new globalObject.TextEncoder() : null;
var alpha = "a".charCodeAt(0) - 10;
var digit = "0".charCodeAt(0);
var base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var base64Lookup = new Uint8Array(256);
for (let i = 0; i < base64Chars.length; i++) {
  base64Lookup[base64Chars.charCodeAt(i)] = i;
}
var MAX_HEAP = 16 * 1024;
var wasmMutex = new Mutex();
var mutex$l = new Mutex();
var mutex$k = new Mutex();
var uint32View = new DataView(new ArrayBuffer(4));
var mutex$j = new Mutex();
var mutex$i = new Mutex();
var mutex$h = new Mutex();
var mutex$g = new Mutex();
var polyBuffer = new Uint8Array(8);
var mutex$f = new Mutex();
var mutex$e = new Mutex();
var mutex$d = new Mutex();
var mutex$c = new Mutex();
var mutex$b = new Mutex();
var mutex$a = new Mutex();
var mutex$9 = new Mutex();
var mutex$8 = new Mutex();
var mutex$7 = new Mutex();
var mutex$6 = new Mutex();
var mutex$5 = new Mutex();
var seedBuffer$2 = new Uint8Array(8);
var mutex$4 = new Mutex();
var seedBuffer$1 = new Uint8Array(8);
var mutex$3 = new Mutex();
var seedBuffer = new Uint8Array(8);
var mutex$2 = new Mutex();
var mutex$1 = new Mutex();
var mutex = new Mutex();

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/startup_reservation.ts
var MEMORY_LIMIT = 2 ** 32;
function startupTlsExtent(placement) {
  return placement?.tlsSize === void 0 || placement.tlsAlign === void 0 ? void 0 : {
    size: placement.tlsSize,
    align: placement.tlsAlign
  };
}
function parseDylinkPayload(section) {
  const info = {
    memSize: 0,
    memAlign: 0,
    tableSize: 0,
    needed: []
  };
  while (!section.eof()) {
    const kind = section.byte();
    const sub = section.sub(section.u32());
    if (kind === 1) {
      info.memSize = sub.u32();
      info.memAlign = sub.u32();
      info.tableSize = sub.u32();
    } else if (kind === 2) {
      const count = sub.u32();
      for (let i = 0; i < count; i++) {
        info.needed.push(sub.strictUtf8String());
      }
    }
  }
  return info;
}
function singleDylinkPayload(sections) {
  if (sections.length > 1) {
    throw new MalformedGuestModule(`duplicate dylink.0 sections (${sections.length})`);
  }
  return sections[0];
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/image_report.ts
var IMAGE_REPORT_MAX_LEN = 1024 * 1024;

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/host_events.ts
var encoder = new TextEncoder();
var DOT = Uint8Array.of(46);
var DOT_DOT = Uint8Array.of(46, 46);

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/fs_op.ts
var FS_OP_HEADER_LEN = 40;
var FS_OP_MAX_ARGUMENT_LEN = 1 << 20;
var FS_OP_MAX_REQUEST_LEN = (1 << 20) + 4096 + FS_OP_HEADER_LEN;
var FS_OP_MAX_RESPONSE_CAP = 16 << 20;
var HOST_CALL_RECORD_HEADER_LEN = 20;
var HOST_CALL_RECORD_MAX = HOST_CALL_RECORD_HEADER_LEN + FS_OP_MAX_REQUEST_LEN;
var EMPTY_RESPONSE = new Uint8Array(0);
var RIGHT_READ = 1 << 0;
var RIGHT_WRITE = 1 << 1;
var RIGHT_CREATE = 1 << 2;
var RIGHT_DELETE = 1 << 3;
var RIGHT_SETATTR = 1 << 4;
var RIGHT_SYNC = 1 << 5;
var RIGHT_DEFINED_MASK = RIGHT_READ | RIGHT_WRITE | RIGHT_CREATE | RIGHT_DELETE | RIGHT_SETATTR | RIGHT_SYNC;
var RIGHT_RESERVED_MASK = ~RIGHT_DEFINED_MASK >>> 0;
var FEATURE_DURABLE_DIRECTORY = 1 << 0;
var FEATURE_EXCLUSIVE_CLAIM = 1 << 1;
var FEATURE_RECOVER_LEGACY_LOCK = 1 << 2;
var FEATURE_RETAINED_DIRECTORY = 1 << 3;
var FEATURE_DEFINED_MASK = FEATURE_DURABLE_DIRECTORY | FEATURE_EXCLUSIVE_CLAIM | FEATURE_RECOVER_LEGACY_LOCK | FEATURE_RETAINED_DIRECTORY;
var FEATURE_RESERVED_MASK = ~FEATURE_DEFINED_MASK >>> 0;
var DURABLE_UPPER_REQUIRED_RIGHTS = RIGHT_READ | RIGHT_WRITE | RIGHT_CREATE | RIGHT_DELETE | RIGHT_SETATTR | RIGHT_SYNC;

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/kernel_instance.ts
var MAX_EXECUTABLE_IMAGE_BYTES = 512n * 1024n * 1024n;

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/library_search.ts
function isStringArray(value) {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") return false;
  }
  return true;
}
function normalizeLoaderPolicy(policy) {
  const p = policy;
  if (p === null || p === void 0 || typeof p !== "object") {
    return {
      secure: true
    };
  }
  if (p.secure !== false) return {
    secure: true
  };
  const path = p.libraryPath;
  return isStringArray(path) ? {
    secure: false,
    libraryPath: [
      ...path
    ]
  } : {
    secure: false
  };
}
var CONTINUE_ERRNOS = /* @__PURE__ */ new Set([
  ENOENT,
  ENOTDIR,
  EACCES,
  ENAMETOOLONG
]);
var DEFAULT_DIRS = [
  "/lib",
  "/usr/local/lib",
  "/usr/lib"
];
var LD_LIBRARY_PATH = new TextEncoder().encode("LD_LIBRARY_PATH=");
function libraryCandidates(name, policy, cwd) {
  if (name.includes("/")) return [
    name
  ];
  const dirs = [];
  if (!policy.secure) {
    for (const element of policy.libraryPath ?? []) {
      dirs.push(element.startsWith("/") || cwd === void 0 ? element : `${cwd.replace(/\/+$/, "")}/${element}`);
    }
  }
  return [
    ...dirs,
    ...DEFAULT_DIRS
  ].map((dir) => `${dir.replace(/\/+$/, "")}/${name}`);
}
function createCwdCache(read) {
  let active = false;
  let value;
  return {
    get: () => {
      if (!active) return read();
      return (value ??= {
        cwd: read()
      }).cwd;
    },
    run: (operation) => {
      const outer = active;
      active = true;
      if (!outer) value = void 0;
      try {
        return operation();
      } finally {
        active = outer;
        if (!outer) value = void 0;
      }
    }
  };
}
function needsCwd(name, policy) {
  if (name.includes("/") || policy.secure) return false;
  return (policy.libraryPath ?? []).some((e) => !e.startsWith("/"));
}
function searchLibrary(name, policy, cwd, open, accept) {
  return searchPaths(libraryCandidates(name, policy, needsCwd(name, policy) ? cwd() : "/"), open, accept);
}
function searchPaths(candidates, open, accept) {
  let lastErrno = ENOENT;
  for (const path of candidates) {
    const opened = open(path);
    if (opened.kind === "halt") return {
      kind: "halt",
      path: opened.path
    };
    if (opened.kind === "error") {
      if (!CONTINUE_ERRNOS.has(opened.errno)) {
        return {
          kind: "stop",
          path,
          errno: opened.errno
        };
      }
      lastErrno = opened.errno;
      continue;
    }
    const verdict = accept(opened.path, opened.bytes, opened.file);
    if (!verdict.ok) {
      return {
        kind: "stop",
        path: opened.path,
        errno: verdict.errno
      };
    }
    return {
      kind: "found",
      path: opened.path,
      bytes: opened.bytes,
      ...opened.file !== void 0 && {
        file: opened.file
      }
    };
  }
  return {
    kind: "absent",
    errno: lastErrno
  };
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/runtime_tls_admission.ts
var RUNTIME_TLS_PREFIX = "dlopen: runtime TLS is not supported (#3669): ";
var TLS_CONTRACT_EXPORTS = [
  "__tls_base",
  "__tls_size",
  "__tls_align",
  "__wasm_init_tls"
];
var WASM_SYMBOL_TLS = 256;
var WASM_DYLINK_MEM_INFO = 1;
var WASM_DYLINK_NEEDED = 2;
var WASM_DYLINK_EXPORT_INFO = 3;
function refuse(reason) {
  throw new MalformedGuestModule(RUNTIME_TLS_PREFIX + reason);
}
function tlsFlaggedExports(section) {
  const flagged = /* @__PURE__ */ new Set();
  section.strictString();
  while (!section.eof()) {
    const kind = section.byte();
    const sub = section.sub(section.u32());
    if (kind === WASM_DYLINK_MEM_INFO) {
      for (let i = 0; i < 4; i++) sub.u32();
      continue;
    }
    if (kind === WASM_DYLINK_NEEDED) {
      const needed = sub.u32();
      for (let i = 0; i < needed; i++) sub.strictString();
      continue;
    }
    if (kind !== WASM_DYLINK_EXPORT_INFO) continue;
    const count = sub.u32();
    for (let i = 0; i < count; i++) {
      const name = sub.strictString();
      if ((sub.u32() & WASM_SYMBOL_TLS) !== 0) flagged.add(name);
    }
  }
  return flagged;
}
function rejectRuntimeTlsModule(bytes) {
  try {
    scanRuntimeTlsModule(bytes);
  } catch (error) {
    if (error instanceof MalformedGuestModule && error.message.startsWith(RUNTIME_TLS_PREFIX)) throw error;
  }
}
function scanRuntimeTlsModule(bytes) {
  const cursor = new WasmCursor(bytes);
  if (bytes.length < 8) return;
  cursor.skip(8);
  const gotMemImports = [];
  let tlsFlagged = /* @__PURE__ */ new Set();
  let sawDylink = false;
  while (!cursor.eof()) {
    const id = cursor.byte();
    const section = cursor.sub(cursor.varuint());
    if (id === 0) {
      const probe = new WasmCursor(section.bytes);
      if (probe.string() === "dylink.0") {
        if (sawDylink) refuse("module has more than one dylink.0 section");
        sawDylink = true;
        try {
          tlsFlagged = tlsFlaggedExports(section);
        } catch {
          refuse("module has a malformed dylink.0 section");
        }
      }
    } else if (id === 2) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        const module = section.string();
        const name = section.string();
        const kind = section.byte();
        if (kind === 3) {
          skipGlobalType(section);
          if (module === "env" && name === "__tls_base") {
            refuse("non-JIT module imports env.__tls_base");
          }
          if (module === "GOT.mem") gotMemImports.push(name);
        } else if (kind === 0) {
          section.varuint();
        } else if (kind === 1) {
          skipTableType(section);
        } else if (kind === 2) {
          skipLimits(section);
        } else if (kind === 4) {
          section.varuint();
          section.varuint();
        } else {
          return;
        }
      }
    } else if (id === 7) {
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        const name = section.string();
        section.byte();
        section.varuint();
        if (TLS_CONTRACT_EXPORTS.includes(name)) {
          refuse(`module defines the TLS contract export '${name}'`);
        }
        if (name === "__init_tls") {
          refuse("module exports the Rust-std TLS initialiser '__init_tls'");
        }
      }
    }
  }
  for (const name of gotMemImports) {
    if (tlsFlagged.has(name)) {
      refuse(`module reads its own thread-local '${name}' through the GOT`);
    }
  }
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/loader_diagnostic.ts
var LoaderLoadError = class extends Error {
  libName;
  requester;
  errno;
  constructor(libName, requester, errno, options) {
    super(`Error loading shared library ${libName}: ${strerror(errno)} (needed by ${requester})`, options), this.libName = libName, this.requester = requester, this.errno = errno;
    this.name = "LoaderLoadError";
  }
};
var LoaderRelocationError = class extends Error {
  requester;
  symbol;
  constructor(requester, symbol, message = `Error relocating ${requester}: ${symbol}: symbol not found`) {
    super(message), this.requester = requester, this.symbol = symbol;
    this.name = "LoaderRelocationError";
  }
};
var MUSL_STRERROR = /* @__PURE__ */ new Map([
  [
    84,
    "Illegal byte sequence"
  ],
  [
    33,
    "Domain error"
  ],
  [
    34,
    "Result not representable"
  ],
  [
    25,
    "Not a tty"
  ],
  [
    13,
    "Permission denied"
  ],
  [
    1,
    "Operation not permitted"
  ],
  [
    2,
    "No such file or directory"
  ],
  [
    3,
    "No such process"
  ],
  [
    17,
    "File exists"
  ],
  [
    75,
    "Value too large for data type"
  ],
  [
    28,
    "No space left on device"
  ],
  [
    12,
    "Out of memory"
  ],
  [
    16,
    "Resource busy"
  ],
  [
    4,
    "Interrupted system call"
  ],
  [
    11,
    "Resource temporarily unavailable"
  ],
  [
    29,
    "Invalid seek"
  ],
  [
    18,
    "Cross-device link"
  ],
  [
    30,
    "Read-only file system"
  ],
  [
    39,
    "Directory not empty"
  ],
  [
    104,
    "Connection reset by peer"
  ],
  [
    110,
    "Operation timed out"
  ],
  [
    111,
    "Connection refused"
  ],
  [
    112,
    "Host is down"
  ],
  [
    113,
    "Host is unreachable"
  ],
  [
    98,
    "Address in use"
  ],
  [
    32,
    "Broken pipe"
  ],
  [
    5,
    "I/O error"
  ],
  [
    6,
    "No such device or address"
  ],
  [
    15,
    "Block device required"
  ],
  [
    19,
    "No such device"
  ],
  [
    20,
    "Not a directory"
  ],
  [
    21,
    "Is a directory"
  ],
  [
    26,
    "Text file busy"
  ],
  [
    8,
    "Exec format error"
  ],
  [
    22,
    "Invalid argument"
  ],
  [
    7,
    "Argument list too long"
  ],
  [
    40,
    "Symbolic link loop"
  ],
  [
    36,
    "Filename too long"
  ],
  [
    23,
    "Too many open files in system"
  ],
  [
    24,
    "No file descriptors available"
  ],
  [
    9,
    "Bad file descriptor"
  ],
  [
    10,
    "No child process"
  ],
  [
    14,
    "Bad address"
  ],
  [
    27,
    "File too large"
  ],
  [
    31,
    "Too many links"
  ],
  [
    37,
    "No locks available"
  ],
  [
    35,
    "Resource deadlock would occur"
  ],
  [
    131,
    "State not recoverable"
  ],
  [
    130,
    "Previous owner died"
  ],
  [
    125,
    "Operation canceled"
  ],
  [
    38,
    "Function not implemented"
  ],
  [
    42,
    "No message of desired type"
  ],
  [
    43,
    "Identifier removed"
  ],
  [
    60,
    "Device not a stream"
  ],
  [
    61,
    "No data available"
  ],
  [
    62,
    "Device timeout"
  ],
  [
    63,
    "Out of streams resources"
  ],
  [
    67,
    "Link has been severed"
  ],
  [
    71,
    "Protocol error"
  ],
  [
    74,
    "Bad message"
  ],
  [
    77,
    "File descriptor in bad state"
  ],
  [
    88,
    "Not a socket"
  ],
  [
    89,
    "Destination address required"
  ],
  [
    90,
    "Message too large"
  ],
  [
    91,
    "Protocol wrong type for socket"
  ],
  [
    92,
    "Protocol not available"
  ],
  [
    93,
    "Protocol not supported"
  ],
  [
    94,
    "Socket type not supported"
  ],
  [
    95,
    "Not supported"
  ],
  [
    96,
    "Protocol family not supported"
  ],
  [
    97,
    "Address family not supported by protocol"
  ],
  [
    99,
    "Address not available"
  ],
  [
    100,
    "Network is down"
  ],
  [
    101,
    "Network unreachable"
  ],
  [
    102,
    "Connection reset by network"
  ],
  [
    103,
    "Connection aborted"
  ],
  [
    105,
    "No buffer space available"
  ],
  [
    106,
    "Socket is connected"
  ],
  [
    107,
    "Socket not connected"
  ],
  [
    108,
    "Cannot send after socket shutdown"
  ],
  [
    114,
    "Operation already in progress"
  ],
  [
    115,
    "Operation in progress"
  ],
  [
    116,
    "Stale file handle"
  ],
  [
    117,
    "Data consistency error"
  ],
  [
    119,
    "Resource not available"
  ],
  [
    121,
    "Remote I/O error"
  ],
  [
    122,
    "Quota exceeded"
  ],
  [
    123,
    "No medium found"
  ],
  [
    124,
    "Wrong medium type"
  ],
  [
    72,
    "Multihop attempted"
  ],
  [
    126,
    "Required key not available"
  ],
  [
    127,
    "Key has expired"
  ],
  [
    128,
    "Key has been revoked"
  ],
  [
    129,
    "Key was rejected by service"
  ]
]);
function strerror(errno) {
  return MUSL_STRERROR.get(errno) ?? "No error information";
}
function formatLoaderDiagnostic(error) {
  if (error instanceof LoaderLoadError) {
    return [
      "Error loading shared library ",
      error.libName,
      ": ",
      strerror(error.errno),
      " (needed by ",
      error.requester,
      ")\n"
    ];
  }
  return [
    "Error relocating ",
    error.requester,
    ": ",
    error.symbol,
    ": symbol not found\n"
  ];
}
function isLoaderError(error) {
  return error instanceof LoaderLoadError || error instanceof LoaderRelocationError;
}
var DIAGNOSTIC_WINDOW_BYTES = 4096;
var SIGNAL_DELIVERY_BYTES = 344;
var DIAGNOSTIC_EINTR_RETRIES = 64;
var PROT_READ_WRITE = 3n;
var MAP_PRIVATE_ANONYMOUS = 0x22n;
function reportLoaderFailure(memory, error, syscall) {
  let base = 0;
  let size = Math.min(DIAGNOSTIC_WINDOW_BYTES, memory.buffer.byteLength);
  if (size === 0) {
    const mapped = syscall(LINUX_NR_MMAP, 0n, BigInt(DIAGNOSTIC_WINDOW_BYTES), PROT_READ_WRITE, MAP_PRIVATE_ANONYMOUS, -1n, 0n);
    if (mapped >= 0n) {
      base = Number(mapped);
      size = DIAGNOSTIC_WINDOW_BYTES;
    }
  } else {
    base = memory.buffer.byteLength - size;
  }
  const write = (bytes) => {
    new Uint8Array(memory.buffer, base, bytes.length).set(bytes);
    return syscall(LINUX_NR_WRITE, 2n, BigInt(base), BigInt(bytes.length), 0n, 0n, 0n);
  };
  const takePendingSignals = () => {
    if (size >= SIGNAL_DELIVERY_BYTES) {
      syscall(METHOD.SYS_SIGNAL_POLL, BigInt(base), 0n, 0n, 0n, 0n, 0n);
    }
  };
  let interrupted = 0;
  if (size > 0) {
    const encoder2 = new TextEncoder();
    writing: for (const part of formatLoaderDiagnostic(error)) {
      const bytes = encoder2.encode(part);
      for (let offset = 0; offset < bytes.length; ) {
        const chunk = Math.min(size, bytes.length - offset);
        for (let done = 0; done < chunk; ) {
          const rc = write(bytes.subarray(offset + done, offset + chunk));
          if (rc < 0n) takePendingSignals();
          if (rc === BigInt(-EINTR)) {
            if (++interrupted > DIAGNOSTIC_EINTR_RETRIES) break writing;
            continue;
          }
          interrupted = 0;
          if (rc <= 0n) break writing;
          done += Number(rc);
        }
        offset += chunk;
      }
    }
  }
  syscall(LINUX_NR_EXIT_GROUP, 127n, 0n, 0n, 0n, 0n, 0n);
  throw new Error("exit_group(127) returned to the startup loader");
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/append_bytes.ts
function appendBytes(out, bytes) {
  out.append(bytes);
}
var ByteAccumulator = class {
  #bytes = new Uint8Array(256);
  #length = 0;
  get length() {
    return this.#length;
  }
  push(...values) {
    this.ensure(values.length);
    this.#bytes.set(values, this.#length);
    this.#length += values.length;
    return this.#length;
  }
  append(bytes) {
    this.ensure(bytes.length);
    this.#bytes.set(bytes, this.#length);
    this.#length += bytes.length;
  }
  finish() {
    return this.#bytes.slice(0, this.#length);
  }
  ensure(extra) {
    const needed = this.#length + extra;
    if (needed <= this.#bytes.length) return;
    let capacity = this.#bytes.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#bytes);
    this.#bytes = grown;
  }
};

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/runtime_link_replay.ts
var REPLAY_EXPORT_PREFIX = "__yurt_replay_";
function isReplayPrivateExport(name) {
  return name.startsWith(REPLAY_EXPORT_PREFIX);
}
function skipByteVector(cursor) {
  cursor.skip(cursor.varuint());
}
function countActiveDataSegments(section) {
  let active = 0;
  const count = section.varuint();
  for (let i = 0; i < count; i++) {
    const flags = section.varuint();
    if (flags === 0) {
      active++;
      skipConstExpr(section);
    } else if (flags === 1) {
    } else if (flags === 2) {
      active++;
      section.varuint();
      skipConstExpr(section);
    } else {
      throw new MalformedGuestModule("unsupported wasm data segment flags");
    }
    skipByteVector(section);
  }
  if (!section.eof()) {
    throw new MalformedGuestModule("trailing data section bytes");
  }
  return active;
}
function skipElementPayload(cursor, flags) {
  const expressions = (flags & 4) !== 0;
  switch (flags) {
    case 0:
      skipConstExpr(cursor);
      break;
    case 1:
      cursor.byte();
      break;
    case 2:
      cursor.varuint();
      skipConstExpr(cursor);
      cursor.byte();
      break;
    case 3:
      cursor.byte();
      break;
    case 4:
      skipConstExpr(cursor);
      break;
    case 5:
      cursor.byte();
      break;
    case 6:
      cursor.varuint();
      skipConstExpr(cursor);
      cursor.byte();
      break;
    case 7:
      cursor.byte();
      break;
    default:
      throw new MalformedGuestModule("unsupported wasm element segment flags");
  }
  const count = cursor.varuint();
  for (let i = 0; i < count; i++) {
    if (expressions) skipConstExpr(cursor);
    else cursor.varuint();
  }
}
function countActiveElementSegments(section) {
  let active = 0;
  const count = section.varuint();
  for (let i = 0; i < count; i++) {
    const flags = section.varuint();
    if (flags === 0 || flags === 2 || flags === 4 || flags === 6) active++;
    skipElementPayload(section, flags);
  }
  if (!section.eof()) {
    throw new MalformedGuestModule("trailing element section bytes");
  }
  return active;
}
function analyzeReplayModule(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 97 || bytes[2] !== 115 || bytes[3] !== 109 || bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
    throw new MalformedGuestModule("bad wasm magic or version");
  }
  const cursor = new WasmCursor(bytes);
  cursor.pos = 8;
  const result = {
    hasStart: false,
    activeDataSegments: 0,
    activeElementSegments: 0
  };
  while (!cursor.eof()) {
    const sectionId = cursor.byte();
    const section = cursor.sub(cursor.varuint());
    if (sectionId === 8) result.hasStart = true;
    else if (sectionId === 9) {
      result.activeElementSegments += countActiveElementSegments(section);
    } else if (sectionId === 11) {
      result.activeDataSegments += countActiveDataSegments(section);
    }
  }
  return result;
}
function encodeU32(value) {
  const bytes = new ByteAccumulator();
  do {
    const next = value >>> 7;
    bytes.push(value & 127 | (next === 0 ? 0 : 128));
    value = next;
  } while (value !== 0);
  return bytes.finish();
}
function rawSections(bytes) {
  const sections = [];
  let offset = 8;
  while (offset < bytes.length) {
    const id = bytes[offset++];
    const lengthStart = offset;
    const lengthCursor = new WasmCursor(bytes);
    lengthCursor.pos = offset;
    const length = lengthCursor.varuint();
    offset = lengthStart;
    offset = lengthCursor.pos;
    sections.push({
      id,
      payload: bytes.slice(offset, offset + length)
    });
    offset += length;
  }
  return sections;
}
function appendStartExport(payload, functionIndex) {
  const cursor = new WasmCursor(payload);
  const count = cursor.varuint();
  const countEnd = cursor.pos;
  const name = new TextEncoder().encode("__yurt_replay_start");
  const entry = [
    ...encodeU32(name.length),
    ...name,
    0,
    ...encodeU32(functionIndex)
  ];
  const out = new ByteAccumulator();
  out.append(encodeU32(count + 1));
  out.append(payload.slice(countEnd));
  out.append(entry);
  return out.finish();
}
function transformReplayModule(bytes) {
  const analysis = analyzeReplayModule(bytes);
  if (!analysis.hasStart) return {
    bytes: bytes.slice()
  };
  const sections = rawSections(bytes);
  let startFunction;
  for (const section of sections) {
    if (section.id === 8) {
      const cursor = new WasmCursor(section.payload);
      startFunction = cursor.varuint();
      if (!cursor.eof()) {
        throw new MalformedGuestModule("malformed wasm start section");
      }
    }
  }
  if (startFunction === void 0) throw new Error("missing wasm start index");
  const transformed = [];
  let exportInserted = false;
  for (const section of sections) {
    if (section.id === 8) continue;
    if (section.id === 7) {
      transformed.push({
        id: section.id,
        payload: appendStartExport(section.payload, startFunction)
      });
      exportInserted = true;
    } else {
      if (!exportInserted && section.id > 7) {
        transformed.push({
          id: 7,
          payload: appendStartExport(new Uint8Array([
            0
          ]), startFunction)
        });
        exportInserted = true;
      }
      transformed.push(section);
    }
  }
  if (!exportInserted) {
    transformed.push({
      id: 7,
      payload: appendStartExport(new Uint8Array([
        0
      ]), startFunction)
    });
  }
  const out = new ByteAccumulator();
  out.append(bytes.slice(0, 8));
  for (const section of transformed) {
    out.push(section.id);
    appendBytes(out, encodeU32(section.payload.length));
    appendBytes(out, section.payload);
  }
  return {
    bytes: out.finish(),
    deferredStartExport: "__yurt_replay_start"
  };
}
function assertReplayNamespaceAvailable(module) {
  for (const exportEntry of WebAssembly.Module.exports(module)) {
    if (isReplayPrivateExport(exportEntry.name)) {
      throw new Error(`module export uses reserved replay namespace: ${exportEntry.name}`);
    }
  }
}

// ../yurtos-kernel/packages/kernel-host-interface-js/module-execution-state.ts
var tlsAddressBindings = /* @__PURE__ */ new WeakMap();
var tlsAddressCells = /* @__PURE__ */ new WeakMap();
function tlsAddressBinding(value) {
  return tlsAddressBindings.get(value);
}
function bindTlsAddress(base, offset, cell = new WebAssembly.Global({
  value: "i32",
  mutable: true
}, 0)) {
  const cells = tlsAddressCells.get(base) ?? /* @__PURE__ */ new Map();
  cells.set(cell, offset);
  tlsAddressCells.set(base, cells);
  tlsAddressBindings.set(cell, {
    base,
    offset
  });
  cell.value = Number(base.value) + offset;
  return cell;
}
function setTlsBase(base, address) {
  base.value = address;
  rebaseTlsAddressCells(base);
}
function rebaseTlsAddressCells(base) {
  for (const [cell, offset] of tlsAddressCells.get(base) ?? []) {
    cell.value = Number(base.value) + offset;
  }
}
var InvalidModuleExecutionState = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidModuleExecutionState";
  }
};
function fail(message) {
  throw new InvalidModuleExecutionState(message);
}
function decodeThreadStackBounds(packed) {
  const unsigned = BigInt.asUintN(64, packed);
  if (unsigned === 0n) return void 0;
  const bottom = Number(unsigned & 0xffffffffn);
  const top = Number(unsigned >> 32n & 0xfffffff0n);
  if (bottom >= top) fail("invalid pthread stack bounds");
  return {
    bottom,
    top
  };
}
function encodeThreadStackBounds(bounds) {
  return bounds ? BigInt(bounds.top) << 32n | BigInt(bounds.bottom) : 0n;
}
function isValidTlsLayout(size, align) {
  return Number.isSafeInteger(size) && Number.isSafeInteger(align) && size >= 0 && align >= 0 && !(size > 0 && align === 0) && (align === 0 || (align & align - 1) === 0 && align <= 65536);
}
function key(identity) {
  if (!identity || typeof identity !== "object") {
    fail("invalid module identity");
  }
  if (identity.kind === "main") return "main";
  if (identity.kind !== "dso" || !Number.isSafeInteger(identity.loadIndex) || identity.loadIndex < 0 || typeof identity.path !== "string") fail("invalid module identity");
  return `dso:${identity.loadIndex}`;
}
var globalTypes = [
  0,
  1
].map((mutable) => new WebAssembly.Module(new Uint8Array([
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  2,
  10,
  1,
  3,
  101,
  110,
  118,
  1,
  103,
  3,
  127,
  mutable
])));
var tlsInitializerType = new WebAssembly.Module(new Uint8Array([
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  5,
  1,
  96,
  1,
  127,
  0,
  2,
  9,
  1,
  3,
  101,
  110,
  118,
  1,
  102,
  0,
  0
]));
function i32Global(value, mutable) {
  if (!(value instanceof WebAssembly.Global)) fail("missing execution global");
  try {
    new WebAssembly.Instance(globalTypes[Number(mutable)], {
      env: {
        g: value
      }
    });
  } catch {
    fail("execution global has wrong type or mutability");
  }
  return value;
}
function mainExecutionBindings(instance, memory, modules = [], threadBounds) {
  const exp = instance.exports;
  const stack = exp.__stack_pointer;
  const stackPointer = stack === void 0 ? null : i32Global(stack, true);
  if (threadBounds !== void 0 && stackPointer !== null) {
    if (!Number.isSafeInteger(threadBounds.bottom) || !Number.isSafeInteger(threadBounds.top) || threadBounds.bottom >= threadBounds.top) fail("invalid pthread stack bounds");
    return {
      stackPointer,
      stackBottom: threadBounds.bottom,
      stackTop: threadBounds.top,
      modules: [
        {
          identity: {
            kind: "main"
          },
          instance
        },
        ...modules
      ]
    };
  }
  return {
    stackPointer,
    stackBottom: stackPointer === null ? 0 : Number(i32Global(exp.__stack_low, false).value) >>> 0,
    stackTop: stackPointer === null ? memory.buffer.byteLength : Number(i32Global(exp.__stack_high, false).value) >>> 0,
    modules: [
      {
        identity: {
          kind: "main"
        },
        instance
      },
      ...modules
    ]
  };
}
var ModuleExecutionRegistry = class {
  memory;
  bindings;
  callerStackTop;
  modules;
  constructor(memory, bindings) {
    this.memory = memory;
    this.bindings = bindings;
    this.callerStackTop = null;
    this.modules = /* @__PURE__ */ new Map();
    if (bindings.stackPointer !== null) i32Global(bindings.stackPointer, true);
    if (!Number.isSafeInteger(bindings.stackBottom) || !Number.isSafeInteger(bindings.stackTop) || bindings.stackBottom < 0 || bindings.stackTop < bindings.stackBottom || bindings.stackTop > memory.buffer.byteLength) fail("invalid stack bounds");
    for (const { identity, instance } of bindings.modules) {
      const id = key(identity);
      if (this.modules.has(id)) fail("duplicate module identity");
      const exp = instance.exports;
      const stack = exp.__stack_pointer;
      if (stack !== void 0 && stack !== bindings.stackPointer) {
        fail("module has a different stack global");
      }
      const hasTls = [
        "__tls_base",
        "__tls_size",
        "__tls_align",
        "__wasm_init_tls"
      ].some((name) => exp[name] !== void 0);
      const base = hasTls ? i32Global(exp.__tls_base, true) : null;
      const size = hasTls ? Number(i32Global(exp.__tls_size, false).value) : null;
      const align = hasTls ? Number(i32Global(exp.__tls_align, false).value) : null;
      if (hasTls && typeof exp.__wasm_init_tls !== "function") {
        fail("missing TLS initializer");
      }
      if (hasTls) {
        try {
          new WebAssembly.Instance(tlsInitializerType, {
            env: {
              f: exp.__wasm_init_tls
            }
          });
        } catch {
          fail("TLS initializer has wrong signature");
        }
      }
      this.modules.set(id, {
        identity: {
          ...identity
        },
        base,
        size,
        align
      });
    }
  }
  /**
   * The one owner of a legitimate stack transition: switch the thread onto
   * the stack a clone(2) caller supplied, so later captures validate against
   * it instead of the emitted shadow stack.
   */
  enterCallerStack(top) {
    if (this.bindings.stackPointer === null) fail("unexpected stack global");
    if (!Number.isSafeInteger(top) || top <= 0 || top > this.memory.buffer.byteLength) fail("caller stack outside linear memory");
    this.callerStackTop = top;
    this.bindings.stackPointer.value = top;
  }
  /**
   * Start a fresh pthread on the stack the host resolved for it: the thread's
   * pointer begins at the top of its bounds, with no caller-supplied stack.
   */
  enterThreadStack() {
    if (this.bindings.stackPointer === null) return;
    this.callerStackTop = null;
    this.bindings.stackPointer.value = this.bindings.stackTop;
  }
  capture() {
    const state = {
      stackPointer: this.bindings.stackPointer === null ? null : Number(this.bindings.stackPointer.value) >>> 0,
      stackBounds: this.bindings.stackPointer === null ? null : {
        bottom: this.bindings.stackBottom,
        top: this.bindings.stackTop
      },
      callerStack: this.callerStackTop === null ? null : {
        top: this.callerStackTop
      },
      modules: this.moduleStates()
    };
    this.validate(state);
    return state;
  }
  /**
   * Each module's TLS record without the stack check. A fresh pthread's
   * instance still holds its module-default stack pointer when its TLS block
   * is planned, so planning must not demand it already lie on the thread's
   * own stack.
   */
  moduleStates() {
    return [
      ...this.modules.values()
    ].map(({ identity, base, size, align }) => ({
      identity: {
        ...identity
      },
      tlsBase: base === null ? null : Number(base.value) >>> 0,
      tlsSize: size,
      tlsAlign: align
    }));
  }
  validate(state) {
    if (!state || !Array.isArray(state.modules) || state.modules.length !== this.modules.size) fail("module identity set mismatch");
    if (this.bindings.stackPointer === null) {
      if (state.stackPointer !== null || state.stackBounds !== null) {
        fail("unexpected stack global");
      }
    } else {
      const caller = state.callerStack ?? null;
      const sp = state.stackPointer;
      if (!state.stackBounds || state.stackBounds.bottom !== this.bindings.stackBottom || state.stackBounds.top !== this.bindings.stackTop || !Number.isSafeInteger(sp) || sp === null) fail("stack pointer outside thread bounds");
      if (caller === null) {
        if (sp < this.bindings.stackBottom || sp > this.bindings.stackTop || sp % 16 !== 0) fail("stack pointer outside thread bounds");
      } else if (!Number.isSafeInteger(caller.top) || caller.top <= 0 || caller.top > this.memory.buffer.byteLength || sp < 0 || sp > caller.top || (caller.top - sp) % 16 !== 0) fail("stack pointer outside caller stack");
    }
    if (this.bindings.stackPointer === null && state.callerStack != null) fail("unexpected stack global");
    const seen = /* @__PURE__ */ new Set();
    for (const saved of state.modules) {
      const id = key(saved.identity);
      const fresh = this.modules.get(id);
      if (!fresh || seen.has(id) || fresh.identity.kind === "dso" && (saved.identity.kind !== "dso" || saved.identity.path !== fresh.identity.path)) fail("module identity set mismatch");
      seen.add(id);
      if (fresh.base === null) {
        if (saved.tlsBase !== null || saved.tlsSize !== null || saved.tlsAlign !== null) fail("unexpected TLS state");
        continue;
      }
      const { tlsBase: base, tlsSize: size, tlsAlign: align } = saved;
      if (base === null || size === null || align === null || size !== fresh.size || align !== fresh.align || !Number.isSafeInteger(base) || base < 0 || !isValidTlsLayout(size, align) || base + size > this.memory.buffer.byteLength || align !== 0 && base % align !== 0) fail("TLS layout or range mismatch");
    }
  }
  restore(state) {
    this.validate(state);
    for (const saved of state.modules) {
      const fresh = this.modules.get(key(saved.identity));
      if (fresh.base !== null) setTlsBase(fresh.base, saved.tlsBase);
    }
    this.callerStackTop = state.callerStack?.top ?? null;
    if (this.bindings.stackPointer !== null) {
      this.bindings.stackPointer.value = state.stackPointer;
    }
  }
};
function threadTlsPlan(memory, bindings) {
  const modules = new ModuleExecutionRegistry(memory, bindings).moduleStates();
  let cursor = 0;
  let alignment = 1;
  const blocks = modules.flatMap((saved, index) => {
    if (saved.tlsSize === null || saved.tlsSize === 0) return [];
    if (!isValidTlsLayout(saved.tlsSize, saved.tlsAlign ?? 0)) {
      fail("TLS layout or range mismatch");
    }
    const align = saved.tlsAlign;
    alignment = Math.max(alignment, align);
    cursor = Math.ceil(cursor / align) * align;
    const offset = cursor;
    cursor += saved.tlsSize;
    const exports = bindings.modules[index].instance.exports;
    return [
      {
        offset,
        size: saved.tlsSize,
        base: exports.__tls_base,
        init: exports.__wasm_init_tls
      }
    ];
  });
  const size = blocks.length === 0 ? 0 : cursor + alignment - 1;
  if (!Number.isSafeInteger(size) || size > 2147483647) {
    fail("thread TLS layout overflow");
  }
  return {
    blocks,
    size,
    alignment
  };
}
function initializeThreadTlsPlan(plan, address, length, memory) {
  const base = Math.ceil(address / plan.alignment) * plan.alignment;
  for (const block of plan.blocks) {
    if (base + block.offset + block.size > address + length || address + length > memory.buffer.byteLength) fail("thread TLS mapping out of bounds");
  }
  for (const block of plan.blocks) {
    setTlsBase(block.base, base + block.offset);
    block.init(base + block.offset);
  }
}
function enterThreadStack(memory, bindings) {
  new ModuleExecutionRegistry(memory, bindings).enterThreadStack();
}
function startupTlsInitializer(memory, module, reservedBase, reserved) {
  const [record] = new ModuleExecutionRegistry(memory, {
    stackPointer: null,
    stackBottom: 0,
    stackTop: memory.buffer.byteLength,
    modules: [
      module
    ]
  }).moduleStates();
  if (record.tlsSize === null || record.tlsSize === 0) return void 0;
  const size = record.tlsSize;
  const align = record.tlsAlign;
  if (!isValidTlsLayout(size, align)) fail("TLS layout or range mismatch");
  const exports = module.instance.exports;
  const tlsBase = exports.__tls_base;
  const init = exports.__wasm_init_tls;
  if (reservedBase === void 0) {
    fail("startup TLS block was not reserved by the host");
  }
  if (reserved === void 0) {
    fail("startup TLS extent was not reserved by the host");
  }
  if (reserved.size !== size) {
    fail(`startup TLS size ${size} differs from the ${reserved.size} the host reserved`);
  }
  if (reserved.align !== align) {
    fail(`startup TLS alignment ${align} differs from the ${reserved.align} the host reserved`);
  }
  if (!Number.isSafeInteger(reservedBase) || reservedBase <= 0) {
    fail(`startup TLS block base ${reservedBase} is not a usable address`);
  }
  if (reservedBase % align !== 0) {
    fail(`startup TLS block base ${reservedBase} is not aligned to ${align}`);
  }
  if (reservedBase + size > memory.buffer.byteLength) {
    fail(`startup TLS block ${reservedBase}+${size} runs past the end of memory`);
  }
  return () => {
    setTlsBase(tlsBase, reservedBase);
    init(reservedBase);
  };
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/worker_terminal.ts
var terminalTrap = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  4,
  1,
  96,
  0,
  0,
  3,
  2,
  1,
  0,
  7,
  8,
  1,
  4,
  116,
  114,
  97,
  112,
  0,
  0,
  10,
  5,
  1,
  3,
  0,
  0,
  11
]))).exports.trap;
function uncatchableTerminal(terminal) {
  try {
    return terminalTrap();
  } catch (trap) {
    if (!(trap instanceof WebAssembly.RuntimeError)) throw trap;
    Object.setPrototypeOf(trap, Object.getPrototypeOf(terminal));
    Object.assign(trap, terminal);
    trap.message = terminal.message;
    return trap;
  }
}
var GuestProcessExited = class extends Error {
  code;
  constructor(code) {
    super(`process exited via syscall(${code})`), this.code = code;
    return uncatchableTerminal(this);
  }
};
var GuestThreadExited = class extends Error {
  code;
  constructor(code) {
    super("thread exited"), this.code = code;
    return uncatchableTerminal(this);
  }
};
function isGuestTerminal(error) {
  return error instanceof GuestProcessExited || error instanceof GuestThreadExited;
}
var SharedVforkExecRequested = class extends Error {
  constructor() {
    super();
    return uncatchableTerminal(this);
  }
};
var ExecRequested = class extends Error {
  pid;
  callerTid;
  prepared;
  constructor(pid, callerTid, prepared) {
    super(`exec requested for pid ${pid}`), this.pid = pid, this.callerTid = callerTid, this.prepared = prepared;
    this.name = "ExecRequested";
    return uncatchableTerminal(this);
  }
};
var ProcessImageReplaced = class extends Error {
  pid;
  constructor(pid) {
    super(`pid ${pid}'s image was replaced by a sibling thread's exec`), this.pid = pid;
    this.name = "ProcessImageReplaced";
    return uncatchableTerminal(this);
  }
};
var ProcessSignalExitRequested = class extends Error {
  signal;
  committed;
  constructor(signal, message, committed = true) {
    super(message ?? `process terminated by signal ${signal}`), this.signal = signal, this.committed = committed;
    this.name = "ProcessSignalExitRequested";
    return uncatchableTerminal(this);
  }
};

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/wasm_helpers.ts
function abortReservedPthreadStart(getExport, startIndex) {
  const abortReservedStart = getExport("yurt_pthread_abort_reserved_start");
  if (typeof abortReservedStart === "function") {
    abortReservedStart(startIndex);
  }
}
var PthreadStartReservation = class {
  getExport;
  startIndex;
  #open;
  constructor(getExport, startIndex) {
    this.getExport = getExport;
    this.startIndex = startIndex;
    this.#open = true;
  }
  /** The trampoline emptied its own slot: nothing is left to release. */
  consume() {
    this.#open = false;
  }
  /** Release the slot unless it was already released or consumed. */
  release() {
    if (!this.#open) return;
    this.#open = false;
    abortReservedPthreadStart(this.getExport, this.startIndex);
  }
};
function abortReservedPthreadStartForCreate(getExport, fnPtr, startIndex) {
  try {
    const table = getExport("__indirect_function_table");
    if (!(table instanceof WebAssembly.Table)) return;
    const trampoline = getExport("yurt_pthread_start_trampoline");
    if (typeof trampoline !== "function") return;
    if (table.get(fnPtr >>> 0) !== trampoline) return;
    abortReservedPthreadStart(getExport, startIndex);
  } catch {
  }
}
function resolvePthreadStartStackBounds(getExport, startIndex) {
  const resolver = getExport("yurt_pthread_start_stack_bounds");
  if (typeof resolver !== "function") {
    return getExport("__stack_pointer") instanceof WebAssembly.Global ? 0 : void 0;
  }
  const packed = resolver(startIndex);
  if (typeof packed !== "bigint") return 0;
  try {
    return decodeThreadStackBounds(packed) ?? 0;
  } catch (error) {
    if (error instanceof InvalidModuleExecutionState) return 0;
    throw error;
  }
}
var ASYNCIFY_EXPORTS = [
  "asyncify_start_unwind",
  "asyncify_stop_unwind",
  "asyncify_start_rewind",
  "asyncify_stop_rewind",
  "asyncify_get_state"
];
function initAsyncifyBridge(bridge, instance, importedMemory, override, executionBindings, runtimeParticipants) {
  const exports = instance.exports;
  const hasAsyncifyState = ASYNCIFY_EXPORTS.every((name) => typeof exports[name] === "function");
  if (!hasAsyncifyState) return false;
  const memory = exports.memory instanceof WebAssembly.Memory ? exports.memory : importedMemory;
  if (!memory) throw new Error("asyncify bridge requires a memory");
  const view = new DataView(memory.buffer);
  let dataAddr;
  let asyncifyBufSize;
  if (override) {
    dataAddr = override.dataAddr;
    asyncifyBufSize = override.dataSize;
  } else {
    const bufGlobal = exports.yurt_asyncify_buf;
    const sizeGlobal = exports.yurt_asyncify_buf_size;
    if (!(bufGlobal instanceof WebAssembly.Global) || !(sizeGlobal instanceof WebAssembly.Global)) {
      throw new Error("asyncify metadata globals are required");
    }
    if (typeof bufGlobal.value !== "number") {
      throw new Error("asyncify metadata global 'yurt_asyncify_buf' is not i32");
    }
    if (typeof sizeGlobal.value !== "number") {
      throw new Error("asyncify metadata global 'yurt_asyncify_buf_size' is not i32");
    }
    dataAddr = bufGlobal.value;
    asyncifyBufSize = view.getUint32(sizeGlobal.value, true);
  }
  if (asyncifyBufSize < 8) {
    throw new Error(`asyncify buffer size must include the 8-byte header, got ${asyncifyBufSize}`);
  }
  if (dataAddr < 0 || dataAddr + asyncifyBufSize > view.byteLength) {
    throw new Error(`asyncify buffer [${dataAddr}, ${dataAddr + asyncifyBufSize}) does not fit guest memory (${view.byteLength} bytes)`);
  }
  view.setUint32(dataAddr, dataAddr + 8, true);
  view.setUint32(dataAddr + 4, dataAddr + asyncifyBufSize, true);
  bridge.initFromInstance(instance, dataAddr, asyncifyBufSize, importedMemory, executionBindings, runtimeParticipants);
  return true;
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/dso_binding.ts
var DsoMissingImportError = class extends Error {
  module;
  symbol;
  constructor(module, symbol) {
    super(`missing import '${module}::${symbol}'`), this.module = module, this.symbol = symbol;
    this.name = "DsoMissingImportError";
  }
};
function bindDsoGlobalAlias(cell, value) {
  const tls = value instanceof WebAssembly.Global ? tlsAddressBinding(value) : void 0;
  if (tls) bindTlsAddress(tls.base, tls.offset, cell);
  else {
    cell.value = value instanceof WebAssembly.Global ? value.value : value;
  }
}
function dsoImportValue(imp, value, functionAddress) {
  if (imp.module !== "GOT.mem" && imp.module !== "GOT.func") return value;
  if (imp.kind !== "global") return void 0;
  if (imp.module === "GOT.mem" && value instanceof WebAssembly.Global && tlsAddressBinding(value)) return value;
  const address = imp.module === "GOT.mem" ? value instanceof WebAssembly.Global ? Number(value.value) : void 0 : typeof value === "function" ? functionAddress() : void 0;
  return address === void 0 ? void 0 : new WebAssembly.Global({
    value: "i32",
    mutable: true
  }, address);
}
function ownDsoGotCell(module, imp) {
  if (imp.kind !== "global") return void 0;
  const kind = imp.module === "GOT.mem" ? "global" : imp.module === "GOT.func" ? "function" : void 0;
  if (!kind || !WebAssembly.Module.exports(module).some((exp) => exp.name === imp.name && exp.kind === kind)) return void 0;
  return new WebAssembly.Global({
    value: "i32",
    mutable: true
  }, 0);
}
function relocatedDsoGlobals(bytes, module, exports, memoryBase) {
  const metadata = wasmLinkMetadata(bytes);
  const flags = /* @__PURE__ */ new Map();
  for (const data of dylinkPayloads(module)) {
    const cursor = new WasmCursor(data);
    while (!cursor.eof()) {
      const kind = cursor.byte();
      const section = cursor.sub(cursor.varuint());
      if (kind !== 3) continue;
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        flags.set(section.string(), section.varuint());
      }
    }
  }
  const globals = /* @__PURE__ */ new Map();
  for (const [name, symbol] of metadata.exports) {
    const value = exports[name];
    if (!(value instanceof WebAssembly.Global)) continue;
    if (((flags.get(name) ?? 0) & 256) !== 0) {
      const base = exports.__tls_base;
      const size = exports.__tls_size;
      const offset = Number(value.value);
      if (!(base instanceof WebAssembly.Global) || !(size instanceof WebAssembly.Global) || !Number.isInteger(offset) || offset < 0 || offset > Number(size.value)) throw new Error(`invalid TLS symbol '${name}'`);
      globals.set(name, bindTlsAddress(base, offset));
      continue;
    }
    const relative = symbol.type === "127:0" && !symbol.imported && !symbol.basedOnGlobal && ((flags.get(name) ?? 0) & 768) === 0 && name !== "__tls_size" && name !== "__tls_align";
    globals.set(name, relative ? new WebAssembly.Global({
      value: "i32",
      mutable: false
    }, Number(value.value) + memoryBase | 0) : value);
  }
  return globals;
}
function dylinkPayloads(module) {
  const payload = singleDylinkPayload(WebAssembly.Module.customSections(module, "dylink.0").map((section) => new Uint8Array(section)));
  return payload === void 0 ? [] : [
    payload
  ];
}
function dsoWeakImports(module) {
  const weak = /* @__PURE__ */ new Set();
  for (const data of dylinkPayloads(module)) {
    const cursor = new WasmCursor(data);
    while (!cursor.eof()) {
      const kind = cursor.byte();
      const section = cursor.sub(cursor.varuint());
      if (kind !== 4) continue;
      const count = section.varuint();
      for (let i = 0; i < count; i++) {
        section.string();
        const field = section.string();
        if ((section.varuint() & 3) === 1) weak.add(field);
      }
    }
  }
  return weak;
}
function resolveDeferredDsoGot(deferred, symbol, functionAddress) {
  for (const { imp, cell, weak, owner } of deferred) {
    const value = symbol(imp.name);
    if (value === void 0) {
      if (weak) continue;
      throw new LoaderRelocationError(owner, imp.name, `startup symbol '${imp.name}' not found (imported by ${owner})`);
    }
    const resolved = dsoImportValue(imp, value, () => functionAddress(imp.name, value));
    if (resolved === void 0) {
      throw new LoaderRelocationError(owner, imp.name, `startup symbol '${imp.name}' has no ${imp.module === "GOT.func" ? "function" : "data"} address (imported by ${owner})`);
    }
    bindDsoGlobalAlias(cell, resolved);
  }
}
function validateDsoReplay(bytes) {
  if (analyzeReplayModule(bytes).activeDataSegments !== 0) {
    throw new Error("module lacks a replay-safe initialization form (active data)");
  }
}
function dsoFunctionExports(module) {
  return WebAssembly.Module.exports(module).filter((exp) => exp.kind === "function" && !isReplayPrivateExport(exp.name) && !ASYNCIFY_EXPORTS.some((name) => name === exp.name) && exp.name !== "__wasm_call_ctors" && exp.name !== "__wasm_apply_data_relocs").map((exp) => exp.name);
}
function dsoInitializerFunctions(instance, runConstructors = true) {
  const initializers = [];
  const constructors = [];
  for (const name of [
    "__yurt_replay_start",
    "__wasm_apply_data_relocs"
  ]) {
    const initialize = instance.exports[name];
    if (typeof initialize === "function") {
      initializers.push(initialize);
    }
  }
  const construct = instance.exports.__wasm_call_ctors;
  if (runConstructors && typeof construct === "function") {
    constructors.push(construct);
  }
  return {
    initializers,
    constructors
  };
}
function tlsRebaseInitializer(instance) {
  const tlsBase = instance.exports.__tls_base;
  return tlsBase instanceof WebAssembly.Global ? () => rebaseTlsAddressCells(tlsBase) : void 0;
}
function bindDso(options) {
  const { bytes, module, memory, table, memoryBase, tableBase, tableSize } = options;
  if (options.initializerMode !== "local") validateDsoReplay(bytes);
  const functions = dsoFunctionExports(module);
  const tableEnd = tableBase + tableSize + functions.length;
  if (table && table.length < tableEnd) table.grow(tableEnd - table.length);
  const ownGot = [];
  const imports = {};
  const importedFunctions = /* @__PURE__ */ new Map();
  const weakImports = dsoWeakImports(module);
  for (const imp of WebAssembly.Module.imports(module)) {
    const group = imports[imp.module] ??= {};
    if (imp.name === "memory") group[imp.name] = memory;
    else if (imp.module === "env" && imp.name === "__indirect_function_table" && imp.kind === "table" && table) {
      group[imp.name] = table;
    } else if (imp.name === "__memory_base" || imp.name === "__table_base") {
      group[imp.name] = new WebAssembly.Global({
        value: "i32",
        mutable: false
      }, imp.name === "__memory_base" ? memoryBase : tableBase);
    } else {
      const value = options.symbol(imp.name);
      let resolved = dsoImportValue(imp, value, () => options.functionAddress(imp.name, value));
      if (resolved === void 0 && value === void 0) {
        const cell = ownDsoGotCell(module, imp);
        if (cell) {
          ownGot.push({
            name: imp.name,
            module: imp.module,
            cell
          });
          resolved = cell;
        }
      }
      if (resolved === void 0 && value !== void 0 && (imp.module === "GOT.mem" && !(value instanceof WebAssembly.Global) || imp.module === "GOT.func" && typeof value !== "function")) {
        throw new Error(`incompatible GOT referent '${imp.name}'`);
      }
      if (resolved === void 0 && value === void 0 && options.deferredGot !== void 0 && imp.kind === "global" && (imp.module === "GOT.mem" || imp.module === "GOT.func")) {
        const cell = new WebAssembly.Global({
          value: "i32",
          mutable: true
        }, 0);
        options.deferredGot.push({
          imp,
          cell,
          weak: weakImports.has(imp.name)
        });
        resolved = cell;
      }
      if (resolved === void 0 && imp.kind === "global") {
        resolved = options.missingGlobal?.(imp);
      }
      if (resolved === void 0 && value === void 0 && imp.kind === "global" && (imp.module === "GOT.mem" || imp.module === "GOT.func") && weakImports.has(imp.name)) {
        resolved = new WebAssembly.Global({
          value: "i32",
          mutable: true
        }, 0);
      }
      if (resolved === void 0) {
        throw new DsoMissingImportError(imp.module, imp.name);
      }
      if (imp.kind === "function" && !importedFunctions.has(resolved)) {
        importedFunctions.set(resolved, imp.name);
      }
      group[imp.name] = resolved;
    }
  }
  const instance = new WebAssembly.Instance(module, imports);
  const symbols = /* @__PURE__ */ new Map();
  const functionSlots = /* @__PURE__ */ new Map();
  functions.forEach((name, offset) => {
    const value = instance.exports[name];
    if (typeof value !== "function") return;
    const imported = importedFunctions.get(value);
    const shared = functionSlots.get(value) ?? (table && imported !== void 0 ? options.existingFunctionSlot?.(imported, value) : void 0);
    const slot = shared ?? tableBase + tableSize + offset;
    if (shared === void 0 && table) {
      table.set(slot, value);
    }
    functionSlots.set(value, slot);
    symbols.set(name, table ? {
      value,
      dlsym: slot
    } : {
      value
    });
  });
  for (const [name, value] of relocatedDsoGlobals(bytes, module, instance.exports, memoryBase)) {
    symbols.set(name, {
      value,
      dlsym: Number(value.value)
    });
  }
  for (const { name, module: namespace, cell } of ownGot) {
    const symbol = symbols.get(name);
    const expected = namespace === "GOT.mem" ? symbol?.value instanceof WebAssembly.Global : typeof symbol?.value === "function";
    if (!expected || symbol?.dlsym === void 0) {
      throw new Error(`DSO GOT symbol '${name}' has no address`);
    }
    const tls = symbol.value instanceof WebAssembly.Global ? tlsAddressBinding(symbol.value) : void 0;
    if (tls) bindTlsAddress(tls.base, tls.offset, cell);
    else cell.value = symbol.dlsym;
  }
  const { initializers, constructors } = options.initializerMode === "shared" ? {
    initializers: [],
    constructors: []
  } : dsoInitializerFunctions(instance, options.runConstructors);
  return {
    instance,
    symbols,
    initializers,
    constructors,
    tlsRebase: tlsRebaseInitializer(instance)
  };
}

// ../yurtos-kernel/packages/kernel-host-interface-js/module-asyncify.ts
var CONTROLS = [
  "asyncify_start_unwind",
  "asyncify_stop_unwind",
  "asyncify_start_rewind",
  "asyncify_stop_rewind",
  "asyncify_get_state"
];
function asyncifySurface(instance) {
  const exports = instance.exports;
  if (!CONTROLS.some((name) => name in exports)) return "none";
  for (const name of CONTROLS) {
    const fn = exports[name];
    if (typeof fn !== "function") {
      throw new Error(`module Asyncify: missing function ${name}`);
    }
    const arity = name === "asyncify_start_unwind" || name === "asyncify_start_rewind" ? 1 : 0;
    if (fn.length !== arity) {
      throw new Error(`module Asyncify: ${name} has the wrong signature`);
    }
  }
  return "full";
}
function transitionModules(controls, transition, dataAddr) {
  for (const { instance } of controls) {
    const exp = instance.exports;
    switch (transition) {
      case "unwind":
        exp.asyncify_start_unwind(dataAddr);
        break;
      case "stopUnwind":
        exp.asyncify_stop_unwind();
        break;
      case "rewind":
        exp.asyncify_start_rewind(dataAddr);
        break;
      case "stopRewind":
        exp.asyncify_stop_rewind();
        break;
    }
  }
}
function identityKey(identity) {
  if (identity.kind === "main") return "main";
  if (identity.kind === "dso") return `dso/${identity.loadIndex}`;
  return `runtime/${identity.generation}`;
}
var ModuleAsyncifyParticipants = class {
  #entries = /* @__PURE__ */ new Map();
  /**
   * Register an instance. Returns false (and records nothing) for an
   * uninstrumented module; throws for a partial or mistyped Asyncify surface
   * and for a duplicate identity.
   */
  register(identity, instance) {
    if (asyncifySurface(instance) === "none") return false;
    const key2 = identityKey(identity);
    if (this.#entries.has(key2)) {
      throw new Error(`module Asyncify: duplicate participant ${key2}`);
    }
    this.#entries.set(key2, {
      identity,
      instance
    });
    return true;
  }
  retire(identity) {
    this.#entries.delete(identityKey(identity));
  }
  list() {
    return [
      ...this.#entries.values()
    ];
  }
};

// ../yurtos-kernel/packages/kernel-host-interface-js/host_impls.ts
var MAX_IN_MEMORY_FILE_BYTES = 512 * 1024 * 1024;
var XATTR_SYMLINK = Symbol("xattr-symlink");
var XATTR_USER_PREFIX = new Uint8Array([
  117,
  115,
  101,
  114,
  46
]);

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/worker_relay_protocol.ts
var RELAY_REPLY_BYTES = 8;
var WORKER_SHARED_VFORK_EXEC_COMMITTED = -2147483392;
var SYSCALL_ENVELOPE_BYTES = 56;
var SYSCALL_ENVELOPE_OFFSET_NR = 0;
var SYSCALL_ENVELOPE_OFFSET_A1 = 8;
var SYSCALL_ENVELOPE_OFFSET_A2 = 16;
var SYSCALL_ENVELOPE_OFFSET_A3 = 24;
var SYSCALL_ENVELOPE_OFFSET_A4 = 32;
var SYSCALL_ENVELOPE_OFFSET_A5 = 40;
var SYSCALL_ENVELOPE_OFFSET_A6 = 48;
var STRUCTURED_RELAY_MAGIC = 1398035020;
var STRUCTURED_RELAY_HEADER_BYTES = 16;
function packSyscallEnvelope(nr, a1, a2, a3, a4, a5, a6) {
  const buf = new ArrayBuffer(SYSCALL_ENVELOPE_BYTES);
  const view = new DataView(buf);
  const writeI64 = (offset, v) => view.setBigInt64(
    offset,
    v,
    /* littleEndian= */
    true
  );
  writeI64(SYSCALL_ENVELOPE_OFFSET_NR, nr);
  writeI64(SYSCALL_ENVELOPE_OFFSET_A1, a1);
  writeI64(SYSCALL_ENVELOPE_OFFSET_A2, a2);
  writeI64(SYSCALL_ENVELOPE_OFFSET_A3, a3);
  writeI64(SYSCALL_ENVELOPE_OFFSET_A4, a4);
  writeI64(SYSCALL_ENVELOPE_OFFSET_A5, a5);
  writeI64(SYSCALL_ENVELOPE_OFFSET_A6, a6);
  return new Uint8Array(buf);
}
function encodeStructuredRelayRequest(method, request, responseCap) {
  const bytes = new Uint8Array(STRUCTURED_RELAY_HEADER_BYTES + request.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, STRUCTURED_RELAY_MAGIC, true);
  view.setUint32(4, method >>> 0, true);
  view.setUint32(8, request.length, true);
  view.setUint32(12, responseCap >>> 0, true);
  bytes.set(request, STRUCTURED_RELAY_HEADER_BYTES);
  return bytes;
}
var FORK_RELAY_SENTINEL_METHOD = 4294967294;
function encodeForkRelayRequest() {
  return encodeStructuredRelayRequest(FORK_RELAY_SENTINEL_METHOD, new Uint8Array(0), 0);
}
var SHARED_VFORK_START_METHOD = 4294967293;
var SHARED_VFORK_FINISH_METHOD = 4294967292;
var IMAGE_SETUP_EXECUTION_METHOD = 4294967291;
function encodeSharedVforkFinish(terminal, exitCode) {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, terminal === "exit" ? 0 : 1, true);
  view.setInt32(4, exitCode | 0, true);
  return bytes;
}
function decodeStructuredRelayReply(bytes) {
  if (bytes.byteLength < 12) {
    throw new RangeError("structured relay reply is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const responseLen = view.getUint32(8, true);
  if (12 + responseLen > bytes.byteLength) {
    throw new RangeError("structured relay reply exceeds mailbox payload");
  }
  return {
    rc: view.getBigInt64(0, true),
    response: bytes.slice(12, 12 + responseLen)
  };
}
var NO_BYTES = new Uint8Array(0);
function withoutResendableBytes(records, operation) {
  return records.map((record) => operation === "publish" && record.fresh ? record : {
    ...record,
    bytes: NO_BYTES
  });
}
function decodeRuntimeModulePayload(payload) {
  if (payload.byteLength < 4) return null;
  const keyLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
  if (4 + keyLength > payload.byteLength) return null;
  const file = new TextDecoder().decode(payload.subarray(4, 4 + keyLength));
  return {
    ...file !== "" && {
      file
    },
    bytes: payload.slice(4 + keyLength)
  };
}
function encodeRuntimeLinkPlan(plan, options = {}) {
  const inline = options.bytes !== "none";
  const out = new ByteAccumulator();
  const encoder2 = new TextEncoder();
  const writeU32 = (value) => {
    out.push(value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24);
  };
  const writeBytes = (bytes) => {
    writeU32(bytes.byteLength);
    appendBytes(out, bytes);
  };
  const writeString = (value) => writeBytes(encoder2.encode(value));
  writeU32(plan.modules.length);
  for (const module of plan.modules) {
    writeString(module.path);
    writeString(module.file ?? "");
    writeBytes(inline ? module.bytes : NO_BYTES);
    writeU32(module.bytesLength ?? module.bytes.byteLength);
    writeU32(module.uploadId ?? 0);
    writeU32(module.generation);
    writeU32(module.memoryBase);
    writeU32(module.memorySize ?? 0);
    writeU32(module.allocationBase ?? module.memoryBase);
    writeU32(module.tableBase);
    writeU32(module.tableSize);
    writeU32(module.refCount);
    writeU32(module.opens);
    out.push(module.global ? 1 : 0, module.nodelete ? 1 : 0, (module.fresh ? 1 : 0) | (module.abort ? 2 : 0));
    writeU32(module.needed.length);
    for (const dependency of module.needed) writeString(dependency);
    const providers = module.implicitProviders ?? [];
    writeU32(providers.length);
    for (const provider of providers) writeString(provider);
    out.push(module.run ? 1 : 0);
    if (module.run) {
      writeU32(module.run.base);
      writeU32(module.run.len);
      writeU32(module.run.recipe.length);
      for (const generation of module.run.recipe) writeU32(generation);
    }
    const closure = module.closure ?? [];
    writeU32(closure.length);
    for (const generation of closure) writeU32(generation);
    writeU32(module.owedBy ?? 0);
  }
  return out.finish();
}
function decodeRuntimeLinkPlan(bytes) {
  const decoder = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const readU32 = () => {
    if (offset + 4 > view.byteLength) {
      throw new RangeError("runtime link plan is truncated");
    }
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const readBytes = () => {
    const length = readU32();
    if (offset + length > view.byteLength) {
      throw new RangeError("runtime link plan exceeds its payload");
    }
    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const readString = () => decoder.decode(readBytes());
  const modules = [];
  for (let i = 0, count = readU32(); i < count; i++) {
    const path = readString();
    const file = readString();
    const moduleBytes = readBytes();
    const bytesLength = readU32();
    const uploadId = readU32();
    const generation = readU32();
    const memoryBase = readU32();
    const memorySize = readU32();
    const allocationBase = readU32();
    const tableBase = readU32();
    const tableSize = readU32();
    const refCount = readU32();
    const opens = readU32();
    if (offset + 3 > view.byteLength) {
      throw new RangeError("runtime link plan is truncated");
    }
    const global2 = view.getUint8(offset++) !== 0;
    const nodelete = view.getUint8(offset++) !== 0;
    const batchFlags = view.getUint8(offset++);
    const fresh = (batchFlags & 1) !== 0;
    const abort = (batchFlags & 2) !== 0;
    const needed = [];
    for (let j = 0, neededCount = readU32(); j < neededCount; j++) {
      needed.push(readString());
    }
    const implicitProviders = [];
    for (let j = 0, providerCount = readU32(); j < providerCount; j++) {
      implicitProviders.push(readString());
    }
    if (offset + 1 > view.byteLength) {
      throw new RangeError("runtime link plan is truncated");
    }
    let run;
    if (view.getUint8(offset++) !== 0) {
      const base = readU32();
      const len = readU32();
      const recipe = [];
      for (let j = 0, count2 = readU32(); j < count2; j++) {
        recipe.push(readU32());
      }
      run = {
        base,
        len,
        recipe
      };
    }
    const closure = [];
    for (let j = 0, count2 = readU32(); j < count2; j++) {
      closure.push(readU32());
    }
    const owedBy = readU32();
    modules.push({
      path,
      ...file !== "" && {
        file
      },
      bytes: moduleBytes,
      ...bytesLength !== moduleBytes.byteLength && {
        bytesLength
      },
      ...uploadId !== 0 && {
        uploadId
      },
      generation,
      memoryBase,
      memorySize,
      allocationBase,
      tableBase,
      tableSize,
      needed,
      ...implicitProviders.length > 0 ? {
        implicitProviders
      } : {},
      refCount,
      opens,
      global: global2,
      nodelete,
      ...fresh && {
        fresh
      },
      ...abort && {
        abort
      },
      ...run && {
        run
      },
      ...closure.length > 0 && {
        closure
      },
      ...owedBy !== 0 && {
        owedBy
      }
    });
  }
  return {
    modules
  };
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/user_imports.ts
var STARTUP_EXECUTION_MODULES = Symbol("yurt.startupExecutionModules");
var MODULE_ASYNCIFY_PARTICIPANTS = Symbol("yurt.moduleAsyncifyParticipants");
var DEFAULT_SCOPE_CHAIN_LENGTH = Symbol("yurt.defaultScopeChainLength");
var STARTUP_DYNLINK_LOADER = Symbol("yurt.startupDynlinkLoader");
var STARTUP_DYNLINK_PLAN = Symbol("yurt.startupDynlinkPlan");
var STARTUP_IMAGE_OBJECTS = Symbol("yurt.startupImageObjects");
var STARTUP_MUTABLE_GLOBAL_STUBS = Symbol("yurt.startupMutableGlobalStubs");
var STARTUP_CTORS_RUNNER = Symbol("yurt.startupCtorsRunner");
var MODULE_OPS_LOADER = Symbol("yurt.moduleOpsLoader");
var LOADER_POLICY = Symbol("yurt.loaderPolicy");
var DYNAMIC_LINK_OPS = Symbol("yurt.dynamicLinkOps");
var CONSTRUCTED_MARKER_WASM = new Uint8Array([
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  4,
  1,
  96,
  0,
  0,
  2,
  7,
  1,
  1,
  109,
  1,
  114,
  0,
  0,
  3,
  2,
  1,
  0,
  7,
  8,
  1,
  4,
  109,
  97,
  114,
  107,
  0,
  1,
  10,
  6,
  1,
  4,
  0,
  16,
  0,
  11
]);
var constructedMarkerModule;
function constructedMarker(report) {
  constructedMarkerModule ??= new WebAssembly.Module(CONSTRUCTED_MARKER_WASM);
  return new WebAssembly.Instance(constructedMarkerModule, {
    m: {
      r: report
    }
  }).exports.mark;
}
function constructedRequest(key2) {
  const request = new Uint8Array(8);
  new DataView(request.buffer).setBigUint64(0, BigInt(key2), true);
  return request;
}
function runInCallOrder(parts, root, marker) {
  const fns = parts.flatMap((part) => part.initializers);
  for (const part of parts) {
    for (const construct of part.constructors) fns.push(construct);
    const mark = part.member === root ? void 0 : marker(part.member);
    if (mark) fns.push(mark);
  }
  return fns;
}
var MAX_PENDING_UPLOAD_BYTES = 2 * MAX_MODULE_BYTES;
var MAX_PENDING_INPUT_BYTES = 2 * MAX_MODULE_BYTES;
var JIT_EIMPORT = 4002;
var JIT_EEXPORT = 4003;
var JIT_EVALIDATE = 4004;
var jitErrnoValue = (errno) => {
  if (errno === "EIMPORT") return JIT_EIMPORT;
  if (errno === "EEXPORT") return JIT_EEXPORT;
  if (errno === "EVALIDATE") return JIT_EVALIDATE;
  return EINVAL;
};
function moduleHasDylink0Section(bytes) {
  const cursor = new WasmCursor(bytes);
  if (bytes.byteLength < 8) return false;
  cursor.skip(8);
  while (!cursor.eof()) {
    const id = cursor.byte();
    const section = cursor.sub(cursor.varuint());
    if (id !== 0) continue;
    if (section.string() === "dylink.0") return true;
  }
  return false;
}
function zeroFreshDsoMemory(memory, memoryBase, memorySize) {
  const clearLength = Math.min(memorySize, memory.buffer.byteLength - memoryBase);
  if (clearLength > 0) {
    new Uint8Array(memory.buffer, memoryBase, clearLength).fill(0);
  }
}
function isPrivateDlsymExport(name) {
  return name === "__tls_size" || name === "__tls_align" || name.startsWith("asyncify_");
}
function mainGlobalDlsymValue(global2) {
  const current = global2.value;
  if (isMutableGlobal(global2)) return null;
  if (typeof current !== "number" || !Number.isInteger(current) || current < -2147483648 || current > 4294967295) return null;
  return current >>> 0;
}
function isDlsymAddressGlobal(global2) {
  return tlsAddressBinding(global2) !== void 0 || !isMutableGlobal(global2);
}
function isMutableGlobal(global2) {
  const current = global2.value;
  try {
    global2.value = current;
    return true;
  } catch {
    return false;
  }
}
function existingFunctionTableSlot(table, value) {
  if (typeof value !== "function") return void 0;
  for (let index = 0; index < table.length; index++) {
    if (table.get(index) === value) return index;
  }
  return void 0;
}
var ASYNCIFY_EXPORT_SIGNATURES = {
  asyncify_start_unwind: "127->",
  asyncify_stop_unwind: "->",
  asyncify_start_rewind: "127->",
  asyncify_stop_rewind: "->",
  asyncify_get_state: "->127"
};
function validateNoRuntimeMutableGlobals(bytes, mode = "runtime") {
  let globalCount = 0;
  let importedFunctions = 0;
  const mutableGlobals = [];
  const relocationGlobals = /* @__PURE__ */ new Set();
  const functionTypes = [];
  const exportedGlobals = /* @__PURE__ */ new Set();
  const globalExports = /* @__PURE__ */ new Map();
  const definitions = /* @__PURE__ */ new Map();
  const functionExports = /* @__PURE__ */ new Map();
  const asyncifyTouched = /* @__PURE__ */ new Set();
  const functionReferences = /* @__PURE__ */ new Set();
  let typeSection;
  const cursor = new WasmCursor(bytes);
  if (cursor.byte() !== 0 || cursor.byte() !== 97 || cursor.byte() !== 115 || cursor.byte() !== 109) {
    throw new MalformedGuestModule("bad wasm magic");
  }
  cursor.skip(4);
  if (mode === "runtime") rejectRuntimeTlsModule(bytes);
  try {
    while (!cursor.eof()) {
      const sectionId = cursor.byte();
      const section = cursor.sub(cursor.varuint());
      switch (sectionId) {
        case 1:
          typeSection = section;
          break;
        case 2: {
          const count = section.varuint();
          for (let i = 0; i < count; i++) {
            const module = section.string();
            const name = section.string();
            const kind = section.byte();
            if (ASYNCIFY_EXPORTS.some((exportName) => exportName === name)) {
              throw new MalformedGuestModule("runtime side module has mutable global");
            }
            if (kind === 3) {
              globalCount++;
              const valueType = section.bytes[section.pos];
              skipValType(section);
              const isMutable = section.byte() !== 0;
              if (module === "env" && name === "__stack_pointer" && (valueType !== 127 || !isMutable)) {
                throw new MalformedGuestModule("side module shadow stack must import mutable i32 env.__stack_pointer");
              }
              const isRelocation = mode !== "jit" && valueType === 127 && (module === "GOT.mem" || module === "GOT.func");
              if (isRelocation) relocationGlobals.add(globalCount - 1);
              if (isMutable && mode !== "startup" && !isRelocation && !(valueType === 127 && module === "env" && (name === "__stack_pointer" || name === "__tls_base"))) {
                throw new MalformedGuestModule("runtime side module has mutable global");
              }
            } else if (kind === 0) {
              functionTypes.push(section.varuint());
              importedFunctions++;
            } else if (kind === 1) {
              skipTableType(section);
            } else if (kind === 2) {
              skipLimits(section);
            } else if (kind === 4) {
              section.varuint();
              section.varuint();
            } else {
              throw new MalformedGuestModule(`unsupported wasm import kind ${kind}`);
            }
          }
          break;
        }
        case 3: {
          const count = section.varuint();
          for (let i = 0; i < count; i++) {
            functionTypes.push(section.varuint());
          }
          break;
        }
        case 5:
          if (mode !== "jit" && section.varuint() !== 0) {
            throw new MalformedGuestModule("side module defines its own memory; it must import env.memory");
          }
          break;
        case 6: {
          const count = section.varuint();
          for (let i = 0; i < count; i++, globalCount++) {
            const valueType = section.bytes[section.pos];
            skipValType(section);
            const mutable = section.byte() !== 0;
            const start = section.pos;
            let initial;
            if (valueType === 127 && section.bytes[start] === 65) {
              section.byte();
              const integerStart = section.pos;
              let value = section.varuint();
              const shift = Math.min(32, (section.pos - integerStart) * 7);
              if (shift < 32 && (section.bytes[section.pos - 1] & 64) !== 0) {
                value |= -1 << shift;
              }
              if (section.byte() === 11) initial = value | 0;
            }
            section.pos = start;
            skipConstExpr(section, (index) => functionReferences.add(index));
            definitions.set(globalCount, {
              type: valueType,
              mutable,
              initial
            });
            if (!mutable) continue;
            if (mode === "jit" || valueType !== 127 || initial !== 0) {
              throw new MalformedGuestModule("runtime side module has mutable global");
            }
            mutableGlobals.push(globalCount);
            if (mutableGlobals.length > (mode === "startup" ? 3 : 2)) {
              throw new MalformedGuestModule("runtime side module has mutable global");
            }
          }
          break;
        }
        case 7: {
          const count = section.varuint();
          for (let i = 0; i < count; i++) {
            const name = section.string();
            const kind = section.byte();
            const index = section.varuint();
            if (kind === 0) functionExports.set(name, index);
            if (kind === 3) {
              exportedGlobals.add(index);
              globalExports.set(name, index);
            }
          }
          break;
        }
        case 9: {
          if (mutableGlobals.length < 2) break;
          const count = section.varuint();
          for (let i = 0; i < count; i++) {
            const flags = section.varuint();
            if (flags > 7) {
              throw new MalformedGuestModule("unsupported element segment");
            }
            if ((flags & 1) === 0) {
              if ((flags & 2) !== 0) section.varuint();
              skipConstExpr(section, (index) => functionReferences.add(index));
            }
            if ((flags & 3) !== 0) {
              if ((flags & 4) !== 0) skipValType(section);
              else section.byte();
            }
            const entries = section.varuint();
            for (let j = 0; j < entries; j++) {
              if ((flags & 4) !== 0) {
                skipConstExpr(section, (index) => functionReferences.add(index));
              } else {
                functionReferences.add(section.varuint());
              }
            }
          }
          break;
        }
        case 10: {
          if (mutableGlobals.length < 2 && relocationGlobals.size === 0) {
            break;
          }
          const asyncifyFunctions = new Set(ASYNCIFY_EXPORTS.map((name) => functionExports.get(name)));
          const count = section.varuint();
          for (let i = 0; i < count; i++) {
            const body = section.sub(section.varuint());
            const functionIndex = importedFunctions + i;
            const accesses = inspectCode(body.bytes, true);
            if (!accesses.globalReads || !accesses.globalWrites || !accesses.functionReferences) {
              throw new MalformedGuestModule("runtime side module has mutable global");
            }
            for (const index of accesses.functionReferences) {
              functionReferences.add(index);
            }
            if (accesses.globalWrites.some((index) => relocationGlobals.has(index))) {
              throw new MalformedGuestModule("runtime side module writes a GOT relocation global");
            }
            if (asyncifyFunctions.has(functionIndex)) {
              for (const index of accesses.globalReads) {
                asyncifyTouched.add(index);
              }
              for (const index of accesses.globalWrites) {
                asyncifyTouched.add(index);
              }
            } else if (accesses.globalWrites.some((index) => mutableGlobals.includes(index) && !(mode === "startup" && globalExports.get("__tls_base") === index))) {
              throw new MalformedGuestModule("runtime side module has mutable global");
            }
          }
          break;
        }
      }
    }
    if ([
      ...relocationGlobals
    ].some((index) => exportedGlobals.has(index))) {
      throw new MalformedGuestModule("runtime side module exports a GOT relocation global");
    }
    if (ASYNCIFY_EXPORTS.some((name) => functionExports.has(name)) && !hasAsyncifyExports(typeSection && new WasmCursor(typeSection.bytes), functionTypes, functionExports)) {
      throw new MalformedGuestModule("runtime side module has a malformed Asyncify surface");
    }
    let tlsIndex;
    if (mode === "startup" && ([
      "__tls_base",
      "__tls_size",
      "__tls_align"
    ].some((name) => globalExports.has(name)) || functionExports.has("__wasm_init_tls"))) {
      const index = globalExports.get("__tls_base");
      const base = definitions.get(index);
      const size = definitions.get(globalExports.get("__tls_size"));
      const align = definitions.get(globalExports.get("__tls_align"));
      const initializer = functionExports.get("__wasm_init_tls");
      const signatures = [];
      if (typeSection) {
        const types = new WasmCursor(typeSection.bytes);
        const count = types.varuint();
        for (let i = 0; i < count; i++) {
          signatures.push(readFunctionType(types));
        }
      }
      const alignment = align?.initial;
      if (base?.type !== 127 || !base.mutable || base.initial !== 0 || size?.type !== 127 || size.mutable || size.initial === void 0 || size.initial < 0 || align?.type !== 127 || align.mutable || alignment === void 0 || alignment < 0 || !isValidTlsLayout(size.initial, alignment) || initializer === void 0 || signatures[functionTypes[initializer]] !== "127->" || [
        ...globalExports
      ].some(([name, exported]) => exported === index && name !== "__tls_base")) {
        throw new MalformedGuestModule("startup side module has invalid TLS contract");
      }
      tlsIndex = index;
    }
    const unmanaged = mutableGlobals.filter((index) => index !== tlsIndex);
    if (unmanaged.length === 0) return;
    const asyncifyPair = unmanaged.length === 2 && asyncifyTouched.size === 2 && ASYNCIFY_EXPORTS.every((name) => {
      const index = functionExports.get(name);
      return index !== void 0 && !functionReferences.has(index) && [
        ...functionExports
      ].every(([exportName, exportedIndex]) => exportedIndex !== index || exportName === name || name === "asyncify_stop_unwind" && exportName === "asyncify_stop_rewind" || name === "asyncify_stop_rewind" && exportName === "asyncify_stop_unwind");
    }) && unmanaged.every((index) => asyncifyTouched.has(index) && !exportedGlobals.has(index)) && hasAsyncifyExports(typeSection, functionTypes, functionExports);
    if (asyncifyPair) return;
  } catch (error) {
    if (mutableGlobals.length === 0 || !(error instanceof MalformedGuestModule)) {
      throw error;
    }
  }
  throw new MalformedGuestModule("runtime side module has mutable global");
}
function hasAsyncifyExports(typeSection, functionTypes, functionExports) {
  if (!typeSection) return false;
  const signatures = [];
  const count = typeSection.varuint();
  for (let i = 0; i < count; i++) {
    const signature = readFunctionType(typeSection);
    if (signature === void 0) break;
    signatures.push(signature);
  }
  return ASYNCIFY_EXPORTS.every((name) => {
    const index = functionExports.get(name);
    return index !== void 0 && signatures[functionTypes[index]] === ASYNCIFY_EXPORT_SIGNATURES[name];
  });
}
function inspectCode(code, collectGlobalAccesses = false) {
  const cursor = new WasmCursor(code);
  let hasDirectMemoryGrow2 = false;
  let mutatesSharedTable = false;
  const globalReads = collectGlobalAccesses ? [] : void 0;
  const globalWrites = collectGlobalAccesses ? [] : void 0;
  const functionReferences = collectGlobalAccesses ? [] : void 0;
  const localDecls = cursor.varuint();
  for (let i = 0; i < localDecls; i++) {
    cursor.varuint();
    skipValType(cursor);
  }
  let controlDepth = 1;
  while (!cursor.eof()) {
    const op = cursor.byte();
    switch (op) {
      case 11:
        controlDepth--;
        if (controlDepth === 0) {
          if (!cursor.eof()) {
            throw new MalformedGuestModule("trailing code after function end");
          }
          return {
            mutatesSharedTable,
            hasDirectMemoryGrow: hasDirectMemoryGrow2,
            globalReads,
            globalWrites,
            functionReferences
          };
        }
        break;
      case 38:
        if (cursor.varuint() === 0) {
          mutatesSharedTable = true;
          if (!collectGlobalAccesses) {
            return {
              mutatesSharedTable,
              hasDirectMemoryGrow: hasDirectMemoryGrow2
            };
          }
        }
        break;
      case 252: {
        const subop = cursor.varuint();
        if (subop <= 7) {
        } else if (subop === 12) {
          cursor.varuint();
          if (cursor.varuint() === 0) {
            mutatesSharedTable = true;
            if (!collectGlobalAccesses) {
              return {
                mutatesSharedTable,
                hasDirectMemoryGrow: hasDirectMemoryGrow2
              };
            }
          }
        } else if (subop === 13) {
          cursor.varuint();
        } else if (subop === 14) {
          if (cursor.varuint() === 0) {
            mutatesSharedTable = true;
            if (!collectGlobalAccesses) {
              return {
                mutatesSharedTable,
                hasDirectMemoryGrow: hasDirectMemoryGrow2
              };
            }
          }
          cursor.varuint();
        } else if (subop === 15 || subop === 17) {
          if (cursor.varuint() === 0) {
            mutatesSharedTable = true;
            if (!collectGlobalAccesses) {
              return {
                mutatesSharedTable,
                hasDirectMemoryGrow: hasDirectMemoryGrow2
              };
            }
          }
        } else if (subop === 16) {
          cursor.varuint();
        } else if (subop === 8 || subop === 10) {
          cursor.varuint();
          cursor.varuint();
        } else if (subop === 9 || subop === 11) {
          cursor.varuint();
        } else {
          throw new MalformedGuestModule(`unsupported 0xfc opcode ${subop}`);
        }
        break;
      }
      case 253: {
        const subop = cursor.varuint();
        skipSimdImmediate(cursor, subop);
        break;
      }
      case 254: {
        const subop = cursor.varuint();
        if (subop === 3) {
          cursor.byte();
        } else if (subop <= 2 || subop >= 16 && subop <= 78) {
          skipMemArg(cursor);
        } else {
          throw new MalformedGuestModule(`unsupported 0xfe opcode ${subop}`);
        }
        break;
      }
      case 2:
      case 3:
      case 4: {
        skipBlockType(cursor);
        controlDepth++;
        break;
      }
      case 31: {
        skipBlockType(cursor);
        const catchCount = cursor.varuint();
        for (let i = 0; i < catchCount; i++) {
          switch (cursor.byte()) {
            case 0:
            case 1:
              cursor.varuint();
              cursor.varuint();
              break;
            case 2:
            case 3:
              cursor.varuint();
              break;
            default:
              throw new MalformedGuestModule("unsupported try_table catch kind");
          }
        }
        controlDepth++;
        break;
      }
      case 5:
        break;
      // Legacy exception handling, which clang's -fwasm-exceptions emits (#3476).
      case 6:
        skipBlockType(cursor);
        controlDepth++;
        break;
      case 7:
        cursor.varuint();
        break;
      case 9:
        cursor.varuint();
        break;
      case 24:
        cursor.varuint();
        controlDepth--;
        if (controlDepth <= 0) {
          throw new MalformedGuestModule("delegate without matching try");
        }
        break;
      case 25:
        break;
      case 8:
        cursor.varuint();
        break;
      case 10:
        break;
      case 17:
      case 19:
        cursor.varuint();
        cursor.varuint();
        break;
      case 28: {
        const count = cursor.varuint();
        for (let i = 0; i < count; i++) skipValType(cursor);
        break;
      }
      case 12:
      case 13:
      case 32:
      case 33:
      case 34:
      case 37:
      case 63:
      case 208:
        cursor.varuint();
        break;
      case 16:
      case 18:
      case 210: {
        const index = cursor.varuint();
        functionReferences?.push(index);
        break;
      }
      case 35: {
        const index = cursor.varuint();
        globalReads?.push(index);
        break;
      }
      case 36: {
        const index = cursor.varuint();
        globalWrites?.push(index);
        break;
      }
      case 64:
        cursor.varuint();
        hasDirectMemoryGrow2 = true;
        break;
      case 40:
      case 41:
      case 42:
      case 43:
      case 44:
      case 45:
      case 46:
      case 47:
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
      case 58:
      case 59:
      case 60:
      case 61:
      case 62:
        skipMemArg(cursor);
        break;
      case 65:
        cursor.varint();
        break;
      case 66:
        cursor.varint(70);
        break;
      case 14: {
        const n = cursor.varuint();
        for (let i = 0; i <= n; i++) cursor.varuint();
        break;
      }
      case 67:
        cursor.skip(4);
        break;
      case 68:
        cursor.skip(8);
        break;
      case 0:
      case 1:
      case 15:
      case 26:
      case 27:
      case 69:
      case 70:
      case 71:
      case 72:
      case 73:
      case 74:
      case 75:
      case 76:
      case 77:
      case 78:
      case 79:
      case 80:
      case 81:
      case 82:
      case 83:
      case 84:
      case 85:
      case 86:
      case 87:
      case 88:
      case 89:
      case 90:
      case 91:
      case 92:
      case 93:
      case 94:
      case 95:
      case 96:
      case 97:
      case 98:
      case 99:
      case 100:
      case 101:
      case 102:
      case 103:
      case 104:
      case 105:
      case 106:
      case 107:
      case 108:
      case 109:
      case 110:
      case 111:
      case 112:
      case 113:
      case 114:
      case 115:
      case 116:
      case 117:
      case 118:
      case 119:
      case 120:
      case 121:
      case 122:
      case 123:
      case 124:
      case 125:
      case 126:
      case 127:
      case 128:
      case 129:
      case 130:
      case 131:
      case 132:
      case 133:
      case 134:
      case 135:
      case 136:
      case 137:
      case 138:
      case 139:
      case 140:
      case 141:
      case 142:
      case 143:
      case 144:
      case 145:
      case 146:
      case 147:
      case 148:
      case 149:
      case 150:
      case 151:
      case 152:
      case 153:
      case 154:
      case 155:
      case 156:
      case 157:
      case 158:
      case 159:
      case 160:
      case 161:
      case 162:
      case 163:
      case 164:
      case 165:
      case 166:
      case 167:
      case 168:
      case 169:
      case 170:
      case 171:
      case 172:
      case 173:
      case 174:
      case 175:
      case 176:
      case 177:
      case 178:
      case 179:
      case 180:
      case 181:
      case 182:
      case 183:
      case 184:
      case 185:
      case 186:
      case 187:
      case 188:
      case 189:
      case 190:
      case 191:
      case 192:
      case 193:
      case 194:
      case 195:
      case 196:
      case 209:
        break;
      default:
        throw new MalformedGuestModule(`unsupported opcode 0x${op.toString(16)}`);
    }
  }
  throw new MalformedGuestModule("missing function end");
}
function hasDirectMemoryGrow(bytes) {
  const cursor = new WasmCursor(bytes);
  if (cursor.byte() !== 0 || cursor.byte() !== 97 || cursor.byte() !== 115 || cursor.byte() !== 109) throw new MalformedGuestModule("bad wasm magic");
  cursor.skip(4);
  while (!cursor.eof()) {
    const sectionId = cursor.byte();
    const section = cursor.sub(cursor.varuint());
    if (sectionId !== 10) continue;
    const count = section.varuint();
    for (let i = 0; i < count; i++) {
      if (inspectCode(section.sub(section.varuint()).bytes).hasDirectMemoryGrow) {
        return true;
      }
    }
  }
  return false;
}
function validateNoDirectMemoryGrow(bytes) {
  if (hasDirectMemoryGrow(bytes)) {
    throw new WebAssembly.CompileError("guest module contains unguarded direct memory.grow");
  }
}
function validateNoLegacyGrowthImports(bytes) {
  const removed = /* @__PURE__ */ new Set([
    "memory_grow",
    "sys_mmap_prepare",
    "sys_mmap_commit",
    "sys_mmap_abort"
  ]);
  const cursor = new WasmCursor(bytes);
  if (cursor.byte() !== 0 || cursor.byte() !== 97 || cursor.byte() !== 115 || cursor.byte() !== 109) throw new WebAssembly.CompileError("bad wasm magic");
  cursor.skip(4);
  const skipLimits3 = (section) => {
    const flags = section.varuint();
    section.varuint();
    if ((flags & 1) !== 0) section.varuint();
  };
  while (!cursor.eof()) {
    const sectionId = cursor.byte();
    const section = cursor.sub(cursor.varuint());
    if (sectionId !== 2) continue;
    const count = section.varuint();
    for (let i = 0; i < count; i++) {
      const moduleName = section.string();
      const importName = section.string();
      const kind = section.byte();
      const isRemoved = removed.has(importName) && (moduleName === "yurt" || moduleName === "env" && importName.startsWith("sys_mmap_"));
      if (isRemoved) {
        throw new WebAssembly.CompileError(`legacy guest ABI migration: rebuild module without ${moduleName}::${importName}`);
      }
      switch (kind) {
        case 0:
          section.varuint();
          break;
        case 1:
          section.byte();
          skipLimits3(section);
          break;
        case 2:
          skipLimits3(section);
          break;
        case 3:
          section.byte();
          section.byte();
          break;
        case 4:
          section.varuint();
          section.varuint();
          break;
        default:
          throw new WebAssembly.CompileError(`unsupported wasm import kind ${kind}`);
      }
    }
  }
}
function validateJitModule(bytes, engineValidated = false) {
  if (!engineValidated) {
    try {
      new WebAssembly.Module(bytes);
    } catch (e) {
      return {
        ok: false,
        errno: "EVALIDATE",
        message: `invalid wasm: ${e}`
      };
    }
  }
  try {
    const cursor = new WasmCursor(bytes);
    if (cursor.byte() !== 0 || cursor.byte() !== 97 || cursor.byte() !== 115 || cursor.byte() !== 109) {
      return {
        ok: false,
        errno: "EVALIDATE",
        message: "bad wasm magic"
      };
    }
    cursor.skip(4);
    const entries = /* @__PURE__ */ new Map();
    let importedMemory = false;
    let importedTable = false;
    let importsTableBase = false;
    let definedMemories = 0;
    while (!cursor.eof()) {
      const sectionId = cursor.byte();
      const section = cursor.sub(cursor.varuint());
      switch (sectionId) {
        case 2: {
          const count = section.varuint();
          for (let i = 0; i < count; i++) {
            const module = section.string();
            const name = section.string();
            const kind = section.byte();
            if (module === "env" && name === "memory" && kind === 2) {
              if (importedMemory) {
                return {
                  ok: false,
                  errno: "EIMPORT",
                  message: "duplicate memory import"
                };
              }
              importedMemory = true;
              skipLimits(section);
            } else if (module === "env" && name === "__indirect_function_table" && kind === 1) {
              if (importedTable) {
                return {
                  ok: false,
                  errno: "EIMPORT",
                  message: "duplicate table import"
                };
              }
              importedTable = true;
              skipTableType(section);
            } else if (module === "yurt.table" && kind === 0) {
              if (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) > 4294967295) {
                return {
                  ok: false,
                  errno: "EIMPORT",
                  message: `invalid table slot ${name}`
                };
              }
              section.varuint();
            } else if (module === "env" && kind === 3 && (name === "__stack_pointer" || name === "__tls_base")) {
              const type = section.byte();
              const mutable = section.byte();
              if (type !== 127 || name === "__stack_pointer" && mutable !== 1) {
                return {
                  ok: false,
                  errno: "EIMPORT",
                  message: `invalid global type env::${name}`
                };
              }
            } else if (module === "env" && name === "__table_base" && kind === 3) {
              const type = section.byte();
              const mutable = section.byte();
              if (type !== 127 || mutable !== 0 || importsTableBase) {
                return {
                  ok: false,
                  errno: "EIMPORT",
                  message: "invalid global type env::__table_base"
                };
              }
              importsTableBase = true;
            } else {
              return {
                ok: false,
                errno: "EIMPORT",
                message: `unexpected import ${module}::${name}`
              };
            }
          }
          break;
        }
        case 5: {
          const count = section.varuint();
          for (let i = 0; i < count; i++) {
            skipLimits(section);
            definedMemories++;
          }
          break;
        }
        case 7: {
          const count = section.varuint();
          for (let i = 0; i < count; i++) {
            const name = section.string();
            const kind = section.byte();
            const index = section.varuint();
            if (kind === 0 && name.startsWith("__jit_entry_")) {
              const rawOrdinal = name.slice("__jit_entry_".length);
              const ordinal = Number(rawOrdinal);
              if (!/^(0|[1-9][0-9]*)$/.test(rawOrdinal)) {
                return {
                  ok: false,
                  errno: "EEXPORT",
                  message: `invalid entry name ${name}`
                };
              }
              entries.set(ordinal, index);
            }
          }
          break;
        }
        case 9: {
          const count = section.varuint();
          for (let i = 0; i < count; i++) {
            const flags = section.varuint();
            const active = (flags & 1) === 0;
            let tableIndex = 0;
            if (active) {
              if ((flags & 2) !== 0) tableIndex = section.varuint();
              if (tableIndex === 0) {
                return {
                  ok: false,
                  errno: "EVALIDATE",
                  message: "active element segment targets shared table"
                };
              }
              skipConstExpr(section);
            }
            if ((flags & 4) !== 0) skipValType(section);
            else if ((flags & 3) !== 0) section.byte();
            const elemCount = section.varuint();
            for (let j = 0; j < elemCount; j++) {
              if ((flags & 4) !== 0) skipConstExpr(section);
              else section.varuint();
            }
          }
          break;
        }
        case 10: {
          const count = section.varuint();
          for (let i = 0; i < count; i++) {
            if (inspectCode(section.sub(section.varuint()).bytes).mutatesSharedTable) {
              return {
                ok: false,
                errno: "EVALIDATE",
                message: "mounted module mutates shared table"
              };
            }
          }
          break;
        }
        case 4: {
          const count = section.varuint();
          for (let i = 0; i < count; i++) skipTableType(section);
          break;
        }
        case 6: {
          const count = section.varuint();
          for (let i = 0; i < count; i++) {
            skipGlobalType(section);
            skipConstExpr(section);
          }
          break;
        }
        default:
          break;
      }
    }
    if (!importedMemory || !importedTable || definedMemories !== 0) {
      return {
        ok: false,
        errno: "EIMPORT",
        message: "mounted module must import env memory and table"
      };
    }
    if (entries.size === 0) {
      return {
        ok: false,
        errno: "EEXPORT",
        message: "no jit entries"
      };
    }
    const entryNames = [];
    for (let ordinal = 0; ordinal < entries.size; ordinal++) {
      const funcIndex = entries.get(ordinal);
      if (funcIndex === void 0) {
        return {
          ok: false,
          errno: "EEXPORT",
          message: `missing dense ordinal ${ordinal}`
        };
      }
      entryNames.push(`__jit_entry_${ordinal}`);
    }
    return {
      ok: true,
      len: entryNames.length,
      entryNames,
      importsTableBase
    };
  } catch (e) {
    return {
      ok: false,
      errno: "EVALIDATE",
      message: `parse failed: ${e}`
    };
  }
}
var IMAGE_SETUP_EXECUTION = Symbol("yurt.imageSetupExecution");
function createImageSetupExecutionControl(control, active = true) {
  const execution = (phase) => {
    if (!active) return false;
    const applied = control(phase);
    if (phase === 2 && applied) {
      active = false;
      execution.inactive = true;
    }
    return applied;
  };
  execution.inactive = !active;
  return execution;
}
function completeImageActivation(execution) {
  return execution?.(2) ?? false;
}
function withGuestImage(execution, run, direction = "guest") {
  const enter = direction === "guest" ? 0 : 1;
  const leave = direction === "guest" ? 1 : 0;
  let restore = execution?.(enter);
  try {
    return run();
  } catch (error) {
    if (error instanceof ExecRequested || error instanceof ProcessImageReplaced || error instanceof ProcessSignalExitRequested || error instanceof SharedVforkExecRequested || isGuestTerminal(error)) restore = false;
    throw error;
  } finally {
    if (restore) execution?.(leave);
  }
}
function wrapImageExecutionImports(imports, execution) {
  for (const [name, value] of Object.entries(imports)) {
    if (typeof value !== "function") continue;
    const wrapped = function() {
      if (execution.inactive) return value.apply(void 0, arguments);
      return withGuestImage(execution, () => value.apply(void 0, arguments), "host");
    };
    Object.defineProperty(wrapped, "length", {
      value: value.length
    });
    imports[name] = wrapped;
  }
}
function instantiateJitModule(bytes, module, memory, table, getMainExport, reserveSlots) {
  try {
    validateNoLegacyGrowthImports(bytes);
    validateNoDirectMemoryGrow(bytes);
  } catch (e) {
    return {
      ok: false,
      rc: 0,
      message: `dlopen: invalid wasm (${e})`
    };
  }
  const validation = validateJitModule(bytes, true);
  if (!validation.ok) {
    return {
      ok: false,
      rc: -jitErrnoValue(validation.errno),
      message: `${validation.errno}: ${validation.message}`
    };
  }
  try {
    validateNoRuntimeMutableGlobals(bytes, "jit");
  } catch (e) {
    return {
      ok: false,
      rc: 0,
      message: `dlopen: invalid wasm (${e})`
    };
  }
  if (!memory || !table) {
    return {
      ok: false,
      rc: -JIT_EIMPORT,
      message: "EIMPORT: guest memory/table not available"
    };
  }
  const env = {
    memory,
    __indirect_function_table: table
  };
  const functions = /* @__PURE__ */ Object.create(null);
  const bindings = [];
  let reservedBase;
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module === "yurt.table") {
      const slot = Number(imp.name);
      const fn = slot < table.length ? table.get(slot) : null;
      if (fn === null) {
        return {
          ok: false,
          rc: -JIT_EIMPORT,
          message: `EIMPORT: yurt.table::${slot} is null or out of bounds`
        };
      }
      functions[imp.name] = fn;
      bindings.push(`yurt.table::${slot}`);
    } else if (imp.kind === "global" && imp.name === "__table_base") {
      continue;
    } else if (imp.kind === "global") {
      const global2 = getMainExport?.(imp.name);
      if (!(global2 instanceof WebAssembly.Global)) {
        return {
          ok: false,
          rc: -JIT_EIMPORT,
          message: `EIMPORT: guest global ${imp.name} not available`
        };
      }
      env[imp.name] = global2;
      bindings.push(`env::${imp.name}`);
    }
  }
  if (validation.importsTableBase) {
    try {
      reservedBase = reserveSlots(validation.len, table.length);
      if (table.length < reservedBase + validation.len) {
        table.grow(reservedBase + validation.len - table.length);
      }
      env.__table_base = new WebAssembly.Global({
        value: "i32",
        mutable: false
      }, reservedBase);
      bindings.push("env::__table_base");
    } catch (e) {
      return {
        ok: false,
        rc: -JIT_EVALIDATE,
        message: `EVALIDATE: table grow failed: ${e}`
      };
    }
  }
  let instance;
  try {
    instance = new WebAssembly.Instance(module, {
      env,
      "yurt.table": functions
    });
  } catch (e) {
    if (isGuestTerminal(e)) throw e;
    if (e instanceof WebAssembly.LinkError) {
      return {
        ok: false,
        rc: -JIT_EIMPORT,
        message: `EIMPORT: binding ${bindings.join(", ")}: ${e}`
      };
    }
    return {
      ok: false,
      rc: -JIT_EVALIDATE,
      message: `EVALIDATE: instantiate failed: ${e}`
    };
  }
  const exports = instance.exports;
  const funcs = [];
  for (const entryName of validation.entryNames) {
    const fn = exports[entryName];
    if (typeof fn !== "function") {
      return {
        ok: false,
        rc: -JIT_EEXPORT,
        message: `EEXPORT: missing ${entryName}`
      };
    }
    funcs.push(fn);
  }
  let base = reservedBase;
  if (base === void 0) {
    try {
      base = reserveSlots(validation.len, table.length);
      if (table.length < base + validation.len) {
        table.grow(base + validation.len - table.length);
      }
    } catch (e) {
      return {
        ok: false,
        rc: -JIT_EVALIDATE,
        message: `EVALIDATE: table grow failed: ${e}`
      };
    }
  }
  for (let i = 0; i < funcs.length; i++) {
    table.set(base + i, funcs[i]);
  }
  return {
    ok: true,
    base,
    len: validation.len,
    instance
  };
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/startup_layout.ts
var STARTUP_STATE_LOADING = 0;
var STARTUP_STATE_PUBLISHED = 1;
var STARTUP_STATE_SEAL_READY = 2;
var STARTUP_WORD_BYTES = 4;
function setStartupState(buffer, state) {
  const word = new Int32Array(buffer, 0, 1);
  Atomics.store(word, 0, state);
  Atomics.notify(word, 0);
}
function layoutWords(buffer) {
  return new Uint32Array(buffer, STARTUP_WORD_BYTES);
}
function mainFunctions(module) {
  return WebAssembly.Module.exports(module).filter((exp) => exp.kind === "function");
}
function writeStartupLayout(buffer, plan, mainModule) {
  if (buffer.byteLength < STARTUP_WORD_BYTES) {
    throw new Error("startup layout buffer size does not match the module");
  }
  const out = layoutWords(buffer);
  const modules = plan?.modules ?? [];
  const functions = mainFunctions(mainModule);
  if (out.length !== 1 + modules.length * 2 + functions.length) {
    throw new Error("startup layout buffer size does not match the module");
  }
  out[0] = modules.length;
  modules.forEach((module, index) => {
    out[1 + index * 2] = module.memoryBase ?? 0;
    out[2 + index * 2] = module.tableBase ?? 0;
  });
  functions.forEach((exp, index) => {
    out[1 + modules.length * 2 + index] = plan?.mainFunctionSlots?.[exp.name] ?? 4294967295;
  });
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/worker_seal.ts
var UnsupportedCheckpointSeal = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedCheckpointSeal";
  }
};
var SYSCALL_SEAL_UNWIND = -2147483136;

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/checkpoint_state.ts
var InvalidCheckpointState = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidCheckpointState";
  }
};
function ownerKey(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !Number.isSafeInteger(owner.tid) || owner.tid <= 0 || !owner.module) {
    throw new InvalidCheckpointState("invalid checkpoint thread identity");
  }
  const module = owner.module;
  if (module.kind === "main") return `${owner.pid}/${owner.tid}/main`;
  if (module.kind !== "dso" || !Number.isSafeInteger(module.loadIndex) || module.loadIndex < 0 || typeof module.path !== "string" || !module.path) {
    throw new InvalidCheckpointState("invalid checkpoint module identity");
  }
  return JSON.stringify([
    owner.pid,
    owner.tid,
    module.loadIndex,
    module.path
  ]);
}
var CheckpointState = class {
  owner;
  supported;
  hooks;
  #pending;
  #ownerKey;
  constructor(owner, supported, hooks) {
    this.owner = owner;
    this.supported = supported;
    this.hooks = hooks;
    this.#ownerKey = ownerKey(owner);
  }
  withhold(envelope, caller = this.owner) {
    this.#requireOwner(caller);
    this.#requireSupport();
    if (this.#pending) {
      throw new InvalidCheckpointState("duplicate withheld checkpoint request");
    }
    if (!(envelope instanceof Uint8Array) || envelope.byteLength !== 56) {
      throw new InvalidCheckpointState("checkpoint envelope must contain 56 bytes");
    }
    this.#pending = {
      owner: structuredClone(this.owner),
      envelope: envelope.slice(),
      phase: "withheld"
    };
  }
  checkpoint(caller = this.owner) {
    this.#requireOwner(caller);
    if (!this.#pending) {
      if (this.hooks.rewindPending()) {
        throw new InvalidCheckpointState("checkpoint rewind has no pending request");
      }
      return 0;
    }
    this.#requireSupport();
    if (this.hooks.rewindPending()) {
      if (this.#pending.phase !== "rewinding") {
        throw new InvalidCheckpointState("checkpoint rewind reached an unsealed request");
      }
      this.hooks.finishRewind();
      this.#pending = void 0;
      return 1;
    }
    if (this.#pending.phase !== "withheld") {
      throw new InvalidCheckpointState("duplicate checkpoint unwind");
    }
    this.#pending.phase = "rewinding";
    this.hooks.unwind(this.pending());
    return 0;
  }
  pending() {
    return this.#pending ? structuredClone(this.#pending) : void 0;
  }
  restore(pending) {
    this.#requireSupport();
    if (this.#pending) {
      throw new InvalidCheckpointState("checkpoint restore would replace a pending request");
    }
    if (!pending || pending.phase !== "rewinding" || !(pending.envelope instanceof Uint8Array) || pending.envelope.byteLength !== 56) {
      throw new InvalidCheckpointState("malformed restored checkpoint request");
    }
    this.#requireOwner(pending.owner);
    this.#pending = structuredClone(pending);
  }
  #requireOwner(caller) {
    if (ownerKey(caller) !== this.#ownerKey) {
      throw new InvalidCheckpointState("checkpoint request belongs to a different module/thread");
    }
  }
  #requireSupport() {
    if (!this.supported) {
      throw new UnsupportedCheckpointSeal(`pid ${this.owner.pid} tid ${this.owner.tid}: module lacks validated checkpoint support`);
    }
  }
};

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/guest_wait.ts
var GUEST_WAIT_SLICE_MS = 1e3;
function guestWait(view, index, value, timeoutMs) {
  if (timeoutMs !== void 0 && Number.isFinite(timeoutMs)) {
    return Atomics.wait(view, index, value, timeoutMs);
  }
  for (let sliced = false; ; sliced = true) {
    const result = Atomics.wait(view, index, value, GUEST_WAIT_SLICE_MS);
    if (result === "ok") return "ok";
    if (result === "not-equal") return sliced ? "ok" : "not-equal";
  }
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/guest_import_surface.generated.ts
var YURT_IMPORT_TYPES = /* @__PURE__ */ new Map([
  [
    "args_get",
    "127,127->127"
  ],
  [
    "args_sizes_get",
    "127,127->127"
  ],
  [
    "auxv_get",
    "127,127->127"
  ],
  [
    "auxv_sizes_get",
    "127->127"
  ],
  [
    "environ_get",
    "127,127->127"
  ],
  [
    "environ_sizes_get",
    "127,127->127"
  ],
  [
    "host_call_start_routine",
    "127,127->127"
  ],
  [
    "host_checkpoint",
    "->127"
  ],
  [
    "host_longjmp",
    "127,127->"
  ],
  [
    "host_setjmp",
    "127->127"
  ],
  [
    "syscall",
    "127,126,126,126,126,126,126->126"
  ],
  [
    "syscall_fork_family",
    "126,126,126,126,126,126,126->126"
  ]
]);

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/runtime_link_registry.ts
var GATE_STATE = 0;
var GATE_EPOCH = 1;
var GATE_ACK = 2;
var WORKER_STATE = 3;
var GATE_OPEN = 0;
var GATE_CLOSED = 1;
var WORKER_QUIESCENT = 0;
var WORKER_RUNNING = 1;
var RUNTIME_LINK_GATE_WORDS = 4;
function wrapRuntimeLinkGate(buffer) {
  return new Int32Array(buffer, 0, RUNTIME_LINK_GATE_WORDS);
}
function acknowledgeClosedGate(gate) {
  if (Atomics.load(gate, GATE_STATE) !== GATE_CLOSED) return;
  const epoch = Atomics.load(gate, GATE_EPOCH);
  Atomics.store(gate, GATE_ACK, epoch);
  Atomics.notify(gate, GATE_ACK);
}
function tryEnterRuntimeLinkGuest(buffer) {
  const gate = wrapRuntimeLinkGate(buffer);
  if (Atomics.load(gate, GATE_STATE) !== GATE_OPEN) {
    acknowledgeClosedGate(gate);
    return false;
  }
  Atomics.store(gate, WORKER_STATE, WORKER_RUNNING);
  if (Atomics.load(gate, GATE_STATE) === GATE_OPEN) return true;
  Atomics.store(gate, WORKER_STATE, WORKER_QUIESCENT);
  acknowledgeClosedGate(gate);
  return false;
}
function enterRuntimeLinkGuest(buffer) {
  const gate = wrapRuntimeLinkGate(buffer);
  while (!tryEnterRuntimeLinkGuest(buffer)) {
    guestWait(gate, GATE_STATE, GATE_CLOSED);
  }
}
function leaveRuntimeLinkGuest(buffer) {
  const gate = wrapRuntimeLinkGate(buffer);
  Atomics.store(gate, WORKER_STATE, WORKER_QUIESCENT);
  acknowledgeClosedGate(gate);
}
var MAX_SAFE_RANGE = Number.MAX_SAFE_INTEGER;

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/unwind_stubs.ts
function unwindStubImports() {
  return {
    _Unwind_GetIP: (_ctx) => 0,
    _Unwind_GetCFA: (_ctx) => 0,
    // The fourth reference, added 2026-09-13 when yurt-pkg's `pkg` built by
    // guest-sdk-v0.0.19 imported it beside the three above. `pc -> fn`; 0 (no
    // enclosing function) is what yurt_unwind_stub.o answers in-guest.
    _Unwind_FindEnclosingFunction: (_pc) => 0,
    _Unwind_Backtrace: (_callback, _arg) => 0
  };
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/worker_transport.ts
var STATE_CODES = {
  IDLE: 0,
  REQUESTED: 1,
  RUNNING: 2,
  PARK_REQUESTED: 3,
  WAIT_PARKED: 4,
  PARKED: 5,
  WAKE_PENDING: 6,
  REPLIED: 7,
  TERMINATED: 8
};
var CONTROL_SHIFT = 4;
var MAX_GENERATION = Math.floor((2147483647 - 15) / 16);
var CONTROL_INDEX = 0;
var FORWARD_SEQUENCE_INDEX = 1;
var REVERSE_SEQUENCE_INDEX = 2;
var TICKET_INDEX = 3;
var TICKET_HIGH_INDEX = 4;
var REVERSE_STATE_INDEX = 5;
var SIGNAL_PENDING_INDEX = 6;
var CONTROL_WORDS = 7;
var REQUEST_CAPACITY = 4096;
var REPLY_CAPACITY = 4096;
var REVERSE_CAPACITY = 4096;
var REVERSE_STATE_CODES = {
  REVERSE_IDLE: 0,
  REVERSE_REQUESTED: 1,
  REVERSE_RUNNING: 2
};
var VALID_TRANSITIONS = {
  IDLE: [
    "REQUESTED",
    "TERMINATED"
  ],
  REQUESTED: [
    "RUNNING",
    "PARK_REQUESTED",
    "TERMINATED"
  ],
  RUNNING: [
    "REPLIED",
    "PARK_REQUESTED",
    "TERMINATED"
  ],
  PARK_REQUESTED: [
    "WAIT_PARKED",
    "WAKE_PENDING",
    "TERMINATED"
  ],
  WAIT_PARKED: [
    "PARKED",
    "WAKE_PENDING",
    "TERMINATED"
  ],
  PARKED: [
    "WAKE_PENDING",
    "REPLIED",
    "TERMINATED"
  ],
  WAKE_PENDING: [
    "PARKED",
    "REPLIED",
    "TERMINATED"
  ],
  REPLIED: [
    "IDLE",
    "TERMINATED"
  ],
  TERMINATED: []
};
function packControlWord(state, generation) {
  if (!Number.isInteger(generation) || generation < 0 || generation > MAX_GENERATION) {
    throw new RangeError("mailbox generation is out of range");
  }
  return generation * (1 << CONTROL_SHIFT) + STATE_CODES[state];
}
var MAILBOX_BUFFER_BYTE_LENGTH = CONTROL_WORDS * Int32Array.BYTES_PER_ELEMENT + REQUEST_CAPACITY + REPLY_CAPACITY + REVERSE_CAPACITY;
function wrapMailbox(buffer) {
  if (buffer.byteLength !== MAILBOX_BUFFER_BYTE_LENGTH) {
    throw new RangeError(`mailbox buffer has the wrong size: expected ${MAILBOX_BUFFER_BYTE_LENGTH}, got ${buffer.byteLength}`);
  }
  const control = new Int32Array(buffer, 0, CONTROL_WORDS);
  const byteOffset = CONTROL_WORDS * Int32Array.BYTES_PER_ELEMENT;
  const request = new Uint8Array(buffer, byteOffset, REQUEST_CAPACITY);
  const reply = new Uint8Array(buffer, byteOffset + REQUEST_CAPACITY, REPLY_CAPACITY);
  const reverse = new Uint8Array(buffer, byteOffset + REQUEST_CAPACITY + REPLY_CAPACITY, REVERSE_CAPACITY);
  const mailbox = {
    control,
    request,
    reply,
    reverse,
    get controlWord() {
      return Atomics.load(control, CONTROL_INDEX);
    },
    get state() {
      return decodeState(Atomics.load(control, CONTROL_INDEX));
    },
    get generation() {
      return decodeGeneration(Atomics.load(control, CONTROL_INDEX));
    },
    get reverseSequence() {
      return Atomics.load(control, REVERSE_SEQUENCE_INDEX);
    },
    get forwardSequence() {
      return Atomics.load(control, FORWARD_SEQUENCE_INDEX);
    },
    get ticket() {
      const low = BigInt.asUintN(32, BigInt(Atomics.load(control, TICKET_INDEX)));
      const high = BigInt.asUintN(32, BigInt(Atomics.load(control, TICKET_HIGH_INDEX)));
      return high << 32n | low;
    },
    get reverseState() {
      return decodeReverseState(Atomics.load(control, REVERSE_STATE_INDEX));
    },
    get signalPending() {
      return Atomics.load(control, SIGNAL_PENDING_INDEX);
    },
    set signalPending(value) {
      Atomics.store(control, SIGNAL_PENDING_INDEX, value);
    },
    publishTicket: (ticket) => {
      if (ticket < 0n || ticket > 0xffffffffffffffffn) {
        throw new RangeError("mailbox ticket is out of range");
      }
      Atomics.store(control, TICKET_INDEX, Number(BigInt.asIntN(32, ticket)));
      Atomics.store(control, TICKET_HIGH_INDEX, Number(BigInt.asIntN(32, ticket >> 32n)));
    },
    reverseWake: () => {
      const state = decodeState(Atomics.load(control, CONTROL_INDEX));
      if (state !== "PARKED" && state !== "WAIT_PARKED" && state !== "PARK_REQUESTED" && state !== "WAKE_PENDING") {
        throw new Error(`reverse wake requires a parked mailbox, got ${state}`);
      }
      const sequence = Atomics.add(control, REVERSE_SEQUENCE_INDEX, 1) + 1;
      Atomics.store(control, REVERSE_STATE_INDEX, REVERSE_STATE_CODES.REVERSE_REQUESTED);
      Atomics.notify(control, CONTROL_INDEX);
      return sequence;
    },
    acknowledgeReverse: (sequence) => {
      const latest = Atomics.load(control, REVERSE_SEQUENCE_INDEX);
      if (!Number.isInteger(sequence) || sequence <= 0 || sequence > latest || decodeReverseState(Atomics.load(control, REVERSE_STATE_INDEX)) !== "REVERSE_REQUESTED") {
        throw new Error("reverse wake acknowledgement is out of sequence");
      }
      if (sequence !== latest) {
        return;
      }
      Atomics.compareExchange(control, REVERSE_STATE_INDEX, REVERSE_STATE_CODES.REVERSE_REQUESTED, REVERSE_STATE_CODES.REVERSE_IDLE);
      if (Atomics.load(control, REVERSE_SEQUENCE_INDEX) !== sequence) {
        Atomics.store(control, REVERSE_STATE_INDEX, REVERSE_STATE_CODES.REVERSE_REQUESTED);
      }
    },
    writePayload: (lane, data) => {
      const target = lane === "request" ? request : lane === "reply" ? reply : reverse;
      if (data.byteLength > target.byteLength) {
        throw new RangeError("mailbox payload exceeds lane capacity");
      }
      target.fill(0);
      target.set(data);
    },
    readPayload: (lane, length) => {
      const target = lane === "request" ? request : lane === "reply" ? reply : reverse;
      if (!Number.isInteger(length) || length < 0 || length > target.byteLength) throw new RangeError("mailbox payload length is out of bounds");
      return target.slice(0, length);
    },
    reserveForwardSequence: (sequence) => {
      if (!Number.isInteger(sequence) || sequence <= 0) {
        throw new Error("forward request sequence mismatch");
      }
      const previous = Atomics.compareExchange(control, FORWARD_SEQUENCE_INDEX, sequence - 1, sequence);
      if (previous !== sequence - 1) {
        throw new Error("forward request sequence mismatch");
      }
    },
    rollbackForwardSequence: (sequence) => {
      const previous = Atomics.compareExchange(control, FORWARD_SEQUENCE_INDEX, sequence, sequence - 1);
      if (previous !== sequence) {
        throw new Error("forward request sequence rollback mismatch");
      }
    },
    validateForwardSequence: (sequence) => {
      mailbox.reserveForwardSequence(sequence);
    }
  };
  return mailbox;
}
function decodeState(controlWord) {
  const code = controlWord & 15;
  const state = Object.keys(STATE_CODES).find((candidate) => STATE_CODES[candidate] === code);
  if (state === void 0) throw new Error("invalid mailbox control state");
  return state;
}
function decodeGeneration(controlWord) {
  return Math.floor(controlWord / (1 << CONTROL_SHIFT));
}
function decodeReverseState(value1) {
  const state = Object.keys(REVERSE_STATE_CODES).find((candidate) => REVERSE_STATE_CODES[candidate] === value1);
  if (state === void 0) throw new Error("invalid reverse mailbox state");
  return state;
}
function updateMailbox(control, expectedState, generationUpdate, nextState = expectedState) {
  while (true) {
    const current = Atomics.load(control, CONTROL_INDEX);
    const currentState = decodeState(current);
    if (currentState !== expectedState) {
      throw new Error(`invalid mailbox transition: ${currentState} -> ${nextState}`);
    }
    const next = packControlWord(nextState, generationUpdate(decodeGeneration(current)));
    if (Atomics.compareExchange(control, CONTROL_INDEX, current, next) === current) {
      Atomics.notify(control, CONTROL_INDEX);
      return;
    }
  }
}
function transitionMailbox(mailbox, next) {
  const current = mailbox.state;
  if (!VALID_TRANSITIONS[current].includes(next)) {
    throw new Error(`invalid mailbox transition: ${current} -> ${next}`);
  }
  updateMailbox(mailbox.control, current, (generation) => generation + 1, next);
}
function publishWake(mailbox) {
  const control = mailbox.control;
  while (true) {
    const current = Atomics.load(control, CONTROL_INDEX);
    const state = decodeState(current);
    if (state === "WAKE_PENDING" || state === "TERMINATED") {
      return;
    }
    if (state !== "PARK_REQUESTED" && state !== "WAIT_PARKED" && state !== "PARKED") {
      throw new Error(`cannot wake mailbox in ${state}`);
    }
    const next = packControlWord("WAKE_PENDING", decodeGeneration(current) + 1);
    if (Atomics.compareExchange(control, CONTROL_INDEX, current, next) === current) {
      Atomics.notify(control, CONTROL_INDEX);
      return;
    }
  }
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/worker_module_rpc.ts
var CONTROL_WORDS2 = 10;
var STATE_INDEX = 0;
var GENERATION_INDEX = 1;
var METHOD_INDEX = 2;
var REQUEST_LENGTH_INDEX = 3;
var RESPONSE_CAPACITY_INDEX = 4;
var RESPONSE_LENGTH_INDEX = 5;
var RC_LOW_INDEX = 6;
var RC_HIGH_INDEX = 7;
var DEFERRED_UNLOAD_GENERATION_INDEX = 8;
var REENTRANT_SERVICE_INDEX = 9;
var STATE = {
  IDLE: 0,
  REQUESTED: 1,
  RUNNING: 2,
  REPLIED: 3,
  CLOSED: 4
};
var WORKER_MODULE_REQUEST_CAPACITY = (1 << 20) + 16;
var WORKER_MODULE_RESPONSE_CAPACITY = 1 << 20;
var WORKER_RUNTIME_LINK_REQUEST_CAPACITY = 1 << 20;
var WORKER_RUNTIME_LINK_RESPONSE_CAPACITY = 1 << 20;
var WORKER_RPC_DEFAULT_TIMEOUT_MS = 3e4;
var WORKER_RPC_DEFERRED = -2147483647n;
var WorkerRpcCapacityError = class extends RangeError {
  name = "WorkerRpcCapacityError";
};
var WORKER_RPC_TERMINAL_EIO = -5n;
var WORKER_RPC_TIMEOUT = -110n;
var WORKER_MODULE_RPC_OP = {
  LOAD: 1,
  PROMOTE: 2,
  SYMBOL: 3,
  ERROR: 4,
  INFO: 5,
  UNLOAD: 6,
  INIT_RUN: 7,
  /** LOAD whose bytes are a host-staged input, not in the request. */
  LOAD_INPUT: 8
};
function stateName(code) {
  for (const [name, value] of Object.entries(STATE)) {
    if (value === code) return name;
  }
  throw new Error(`invalid Worker RPC state ${code}`);
}
function wrapWorkerRpcChannel(buffer, requestCapacity, responseCapacity) {
  const headerBytes = CONTROL_WORDS2 * Int32Array.BYTES_PER_ELEMENT;
  const expected = headerBytes + requestCapacity + responseCapacity;
  if (buffer.byteLength !== expected) {
    throw new RangeError(`Worker RPC buffer has the wrong size: expected ${expected}, got ${buffer.byteLength}`);
  }
  const control = new Int32Array(buffer, 0, CONTROL_WORDS2);
  const request = new Uint8Array(buffer, headerBytes, requestCapacity);
  const response = new Uint8Array(buffer, headerBytes + requestCapacity, responseCapacity);
  return {
    buffer,
    control,
    request,
    response,
    get state() {
      return stateName(Atomics.load(control, STATE_INDEX));
    },
    get generation() {
      return Atomics.load(control, GENERATION_INDEX) >>> 0;
    }
  };
}
function wrapWorkerModuleOpChannel(buffer) {
  return wrapWorkerRpcChannel(buffer, WORKER_MODULE_REQUEST_CAPACITY, WORKER_MODULE_RESPONSE_CAPACITY);
}
function wrapWorkerRuntimeLinkChannel(buffer) {
  return wrapWorkerRpcChannel(buffer, WORKER_RUNTIME_LINK_REQUEST_CAPACITY, WORKER_RUNTIME_LINK_RESPONSE_CAPACITY);
}
function writeRc(control, rc) {
  const value = BigInt.asUintN(64, rc);
  Atomics.store(control, RC_LOW_INDEX, Number(BigInt.asIntN(32, value)));
  Atomics.store(control, RC_HIGH_INDEX, Number(BigInt.asIntN(32, value >> 32n)));
}
function readRc(control) {
  const low = BigInt.asUintN(32, BigInt(Atomics.load(control, RC_LOW_INDEX)));
  const high = BigInt.asUintN(32, BigInt(Atomics.load(control, RC_HIGH_INDEX)));
  return BigInt.asIntN(64, high << 32n | low);
}
function publishWorkerRpcRequest(channel, method, request, responseCap) {
  if (request.byteLength > channel.request.byteLength) {
    throw new WorkerRpcCapacityError("Worker RPC request exceeds lane capacity");
  }
  if (!Number.isInteger(responseCap) || responseCap < 0 || responseCap > channel.response.byteLength) {
    throw new WorkerRpcCapacityError("Worker RPC response capacity exceeds lane capacity");
  }
  const state = Atomics.load(channel.control, STATE_INDEX);
  if (state !== STATE.IDLE) {
    throw new Error(`Worker RPC request requires IDLE, got ${stateName(state)}`);
  }
  const previousGeneration = Atomics.load(channel.control, GENERATION_INDEX) >>> 0;
  const generation = previousGeneration === 2147483647 ? 1 : previousGeneration + 1;
  channel.request.fill(0);
  channel.request.set(request);
  Atomics.store(channel.control, GENERATION_INDEX, generation);
  Atomics.store(channel.control, METHOD_INDEX, method | 0);
  Atomics.store(channel.control, REQUEST_LENGTH_INDEX, request.byteLength);
  Atomics.store(channel.control, RESPONSE_CAPACITY_INDEX, responseCap);
  Atomics.store(channel.control, RESPONSE_LENGTH_INDEX, 0);
  writeRc(channel.control, 0n);
  Atomics.store(channel.control, STATE_INDEX, STATE.REQUESTED);
  Atomics.notify(channel.control, STATE_INDEX);
  return generation;
}
function takeWorkerRpcRequest(channel) {
  if (Atomics.compareExchange(channel.control, STATE_INDEX, STATE.REQUESTED, STATE.RUNNING) !== STATE.REQUESTED) return void 0;
  const requestLength = Atomics.load(channel.control, REQUEST_LENGTH_INDEX);
  const responseCap = Atomics.load(channel.control, RESPONSE_CAPACITY_INDEX);
  if (requestLength < 0 || requestLength > channel.request.byteLength || responseCap < 0 || responseCap > channel.response.byteLength) {
    closeWorkerRpcChannel(channel, -5n);
    throw new RangeError("Worker RPC request metadata is out of bounds");
  }
  return {
    generation: Atomics.load(channel.control, GENERATION_INDEX) >>> 0,
    method: Atomics.load(channel.control, METHOD_INDEX),
    request: channel.request.slice(0, requestLength),
    responseCap
  };
}
function publishWorkerRpcReply(channel, generation, rc, response) {
  if (channel.state === "CLOSED") return;
  if (channel.state !== "RUNNING") {
    throw new Error(`Worker RPC reply requires RUNNING, got ${channel.state}`);
  }
  if (channel.generation !== generation) {
    throw new Error("Worker RPC reply generation mismatch");
  }
  const responseCap = Atomics.load(channel.control, RESPONSE_CAPACITY_INDEX);
  if (response.byteLength > responseCap) {
    throw new RangeError("Worker RPC reply exceeds requested capacity");
  }
  channel.response.fill(0);
  channel.response.set(response);
  Atomics.store(channel.control, RESPONSE_LENGTH_INDEX, response.byteLength);
  writeRc(channel.control, rc);
  Atomics.store(channel.control, STATE_INDEX, STATE.REPLIED);
  Atomics.notify(channel.control, STATE_INDEX);
}
function consumeWorkerRpcReply(channel, generation) {
  const state = channel.state;
  if (state !== "REPLIED" && state !== "CLOSED") return void 0;
  if (state === "REPLIED" && channel.generation !== generation) {
    throw new Error("Worker RPC response generation mismatch");
  }
  const responseLength = state === "CLOSED" ? 0 : Atomics.load(channel.control, RESPONSE_LENGTH_INDEX);
  if (responseLength < 0 || responseLength > channel.response.byteLength) {
    throw new RangeError("Worker RPC response metadata is out of bounds");
  }
  const reply = {
    rc: readRc(channel.control),
    response: channel.response.slice(0, responseLength)
  };
  if (state === "REPLIED") {
    Atomics.compareExchange(channel.control, DEFERRED_UNLOAD_GENERATION_INDEX, generation, 0);
    Atomics.store(channel.control, STATE_INDEX, STATE.IDLE);
    Atomics.notify(channel.control, STATE_INDEX);
  }
  return reply;
}
function closeWorkerRpcChannel(channel, rc = -5n) {
  if (channel.state === "CLOSED") return;
  writeRc(channel.control, rc);
  Atomics.store(channel.control, RESPONSE_LENGTH_INDEX, 0);
  Atomics.store(channel.control, STATE_INDEX, STATE.CLOSED);
  Atomics.notify(channel.control, STATE_INDEX);
}
function currentChannelState(channel) {
  return channel.state;
}
function serviceWorkerRpcRequestDetailed(channel, dispatch, acknowledgeDeferredUnload = true) {
  if (channel.state === "CLOSED") {
    return {
      state: "closed",
      generation: channel.generation,
      errno: readRc(channel.control)
    };
  }
  if (acknowledgeDeferredUnload && channel.state === "REPLIED") {
    const expected = Atomics.load(channel.control, DEFERRED_UNLOAD_GENERATION_INDEX);
    if (expected !== 0) {
      if (expected !== channel.generation || Atomics.load(channel.control, METHOD_INDEX) !== WORKER_MODULE_RPC_OP.UNLOAD) {
        throw new Error("Worker RPC deferred unload generation mismatch");
      }
      Atomics.store(channel.control, DEFERRED_UNLOAD_GENERATION_INDEX, 0);
      return {
        state: "completed-unload",
        generation: expected
      };
    }
  }
  const request = takeWorkerRpcRequest(channel);
  if (!request) return {
    state: "idle"
  };
  let reply;
  const previousReentrant = Atomics.exchange(channel.control, REENTRANT_SERVICE_INDEX, 1);
  try {
    reply = dispatch(request);
  } catch (error) {
    if (isGuestTerminal(error)) {
      closeWorkerRpcChannel(channel);
      throw error;
    }
    reply = {
      rc: -5n,
      response: new Uint8Array()
    };
  } finally {
    Atomics.store(channel.control, REENTRANT_SERVICE_INDEX, previousReentrant);
  }
  if (currentChannelState(channel) === "CLOSED") {
    return {
      state: "closed",
      generation: request.generation,
      errno: readRc(channel.control)
    };
  }
  try {
    publishWorkerRpcReply(channel, request.generation, reply.rc, reply.response);
  } catch {
    return {
      state: "closed",
      generation: request.generation,
      errno: readRc(channel.control)
    };
  }
  if (currentChannelState(channel) === "CLOSED") {
    return {
      state: "closed",
      generation: request.generation,
      errno: readRc(channel.control)
    };
  }
  return {
    state: "replied",
    generation: request.generation
  };
}
function serviceWorkerRpcRequest(channel, dispatch) {
  return serviceWorkerRpcRequestDetailed(channel, dispatch, false).state !== "idle";
}
function invokeWorkerRpc(channel, method, request, responseCap, options = {}) {
  if (channel.state === "CLOSED") {
    return {
      rc: readRc(channel.control),
      response: new Uint8Array()
    };
  }
  const generation = publishWorkerRpcRequest(channel, method, request, responseCap);
  options.wakePeer?.();
  const deadline = performance.now() + (options.timeoutMs ?? WORKER_RPC_DEFAULT_TIMEOUT_MS);
  for (; ; ) {
    const reply = consumeWorkerRpcReply(channel, generation);
    if (reply) return reply;
    options.serviceNested?.();
    const observed = Atomics.load(channel.control, STATE_INDEX);
    if (observed === STATE.REPLIED || observed === STATE.CLOSED) continue;
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      closeWorkerRpcChannel(channel, WORKER_RPC_TIMEOUT);
      return {
        rc: WORKER_RPC_TIMEOUT,
        response: new Uint8Array()
      };
    }
    Atomics.wait(channel.control, STATE_INDEX, observed, Math.min(remaining, 50));
  }
}
function decodeLoadFile(request, at) {
  if (request.byteLength < at + 4) return null;
  const length = new DataView(request.buffer, request.byteOffset, request.byteLength).getUint32(at, true);
  const end = at + 4 + length;
  if (end > request.byteLength) return null;
  const file = new TextDecoder().decode(request.subarray(at + 4, end));
  return {
    ...file !== "" && {
      file
    },
    end
  };
}
var UNLOAD_ABORT = 1n << 63n;
function requestHostId(request) {
  if (request.byteLength < 8) return void 0;
  const value = new DataView(request.buffer, request.byteOffset, request.byteLength).getBigUint64(0, true);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : void 0;
}
function dispatchWorkerModuleRpcRequest(request, moduleOps, readInput) {
  if (request.method === WORKER_MODULE_RPC_OP.LOAD || request.method === WORKER_MODULE_RPC_OP.LOAD_INPUT) {
    const staged = request.method === WORKER_MODULE_RPC_OP.LOAD_INPUT;
    const keyAt = staged ? 12 : 4;
    const decoded = decodeLoadFile(request.request, keyAt);
    if (decoded === null) return {
      rc: -22n,
      response: new Uint8Array()
    };
    const header = new DataView(request.request.buffer, request.request.byteOffset, request.request.byteLength);
    const flags = header.getUint32(0, true);
    let bytes;
    if (staged) {
      const read = readInput?.(header.getUint32(4, true), header.getUint32(8, true));
      if (!read) return {
        rc: -5n,
        response: new Uint8Array()
      };
      bytes = read;
    } else {
      bytes = request.request.subarray(decoded.end);
    }
    const id = moduleOps.loadFromBytes(bytes, flags, decoded.file);
    const response = new Uint8Array(4);
    if (id > 0) {
      new DataView(response.buffer).setUint32(0, (moduleOps.runLength?.(id) ?? 0) >>> 0, true);
    }
    return {
      rc: BigInt(id),
      response
    };
  }
  if (request.method === WORKER_MODULE_RPC_OP.UNLOAD) {
    if (request.request.byteLength < 8 || request.request.byteLength % 8 !== 0) {
      return {
        rc: -22n,
        response: new Uint8Array()
      };
    }
    const view = new DataView(request.request.buffer, request.request.byteOffset, request.request.byteLength);
    let failed = false;
    for (let offset = 0; offset < request.request.byteLength; offset += 8) {
      const raw = view.getBigUint64(offset, true);
      const abort = (raw & UNLOAD_ABORT) !== 0n;
      const value = raw & ~UNLOAD_ABORT;
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        return {
          rc: -22n,
          response: new Uint8Array()
        };
      }
      try {
        const unloaded = abort && moduleOps.abort ? moduleOps.abort(Number(value)) : moduleOps.unload(Number(value));
        if (typeof unloaded === "number" && unloaded < 0) failed = true;
      } catch (error) {
        if (isGuestTerminal(error)) throw error;
        failed = true;
      }
    }
    return {
      rc: failed ? -5n : 0n,
      response: new Uint8Array()
    };
  }
  const hostId = requestHostId(request.request);
  if (hostId === void 0) {
    return {
      rc: -22n,
      response: new Uint8Array()
    };
  }
  if (request.method === WORKER_MODULE_RPC_OP.PROMOTE) {
    if (request.request.byteLength < 12) {
      return {
        rc: -22n,
        response: new Uint8Array()
      };
    }
    const flags = new DataView(request.request.buffer, request.request.byteOffset + 8, 4).getUint32(0, true);
    return {
      rc: BigInt(moduleOps.promote(hostId, flags)),
      response: new Uint8Array()
    };
  }
  if (request.method === WORKER_MODULE_RPC_OP.SYMBOL) {
    let name;
    try {
      name = new TextDecoder("utf-8", {
        fatal: true
      }).decode(request.request.subarray(8));
    } catch {
      return {
        rc: -22n,
        response: new Uint8Array()
      };
    }
    return {
      rc: BigInt(moduleOps.symbol(hostId, name)),
      response: new Uint8Array()
    };
  }
  if (request.method === WORKER_MODULE_RPC_OP.ERROR) {
    const error = moduleOps.error(hostId);
    if (typeof error === "number") {
      return {
        rc: BigInt(error),
        response: new Uint8Array()
      };
    }
    const response = error === null ? new Uint8Array() : new TextEncoder().encode(error);
    if (response.byteLength > request.responseCap) {
      return {
        rc: -7n,
        response: new Uint8Array()
      };
    }
    return {
      rc: BigInt(response.byteLength),
      response
    };
  }
  if (request.method === WORKER_MODULE_RPC_OP.INFO) {
    const info = moduleOps.info(hostId);
    if (typeof info === "number") {
      return {
        rc: BigInt(info),
        response: new Uint8Array()
      };
    }
    if (!info) return {
      rc: -9n,
      response: new Uint8Array()
    };
    if (request.responseCap < 8) {
      return {
        rc: -22n,
        response: new Uint8Array()
      };
    }
    const response = new Uint8Array(8);
    const view = new DataView(response.buffer);
    view.setUint32(0, info.base >>> 0, true);
    view.setUint32(4, info.len >>> 0, true);
    return {
      rc: 8n,
      response
    };
  }
  if (request.method === WORKER_MODULE_RPC_OP.INIT_RUN) {
    if (request.request.byteLength !== 8 || request.responseCap < 16) {
      return {
        rc: -22n,
        response: new Uint8Array()
      };
    }
    const run = moduleOps.initRun(hostId);
    if (typeof run === "number") {
      return {
        rc: BigInt(run),
        response: new Uint8Array()
      };
    }
    if (!Number.isSafeInteger(run.owner) || run.owner <= 0) {
      return {
        rc: -5n,
        response: new Uint8Array()
      };
    }
    const response = new Uint8Array(16);
    const out = new DataView(response.buffer);
    out.setUint32(0, run.base >>> 0, true);
    out.setUint32(4, run.len >>> 0, true);
    out.setBigUint64(8, BigInt(run.owner), true);
    return {
      rc: 16n,
      response
    };
  }
  return {
    rc: -22n,
    response: new Uint8Array()
  };
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/pending_wake.ts
function takePendingWake(pendingWake) {
  if (Atomics.load(pendingWake, 0) === 0) return false;
  Atomics.store(pendingWake, 0, 0);
  return true;
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/trap_signal.ts
var SIGILL = 4;
var SIGBUS = 7;
var SIGFPE = 8;
var SIGSEGV = 11;
var RULES = [
  // A misaligned atomic: BUS_ADRALN. V8 "operation does not support
  // unaligned accesses", JSC/SpiderMonkey "unaligned memory access".
  [
    /unaligned/i,
    SIGBUS
  ],
  // `ud2`. V8 "unreachable", JSC "Unreachable code should not be executed",
  // SpiderMonkey "unreachable executed".
  [
    /unreachable/i,
    SIGILL
  ],
  // A failed indirect-call type check, which clang's CFI traps with `ud2`.
  // V8 "function signature mismatch", JSC "call_indirect to a signature that
  // does not match", SpiderMonkey "indirect call signature mismatch". V8's
  // older "null function or function signature mismatch" cannot tell the
  // two apart and falls through to the null rule below. JSC cannot tell them
  // apart either: a call through a null table entry is "call_indirect to a
  // signature that does not match" too, in every tier, so on JSC (Safari) a
  // null function pointer call is SIGILL here, not SIGSEGV.
  [
    /^(?!.*null function or).*signature (mismatch|that does not match)/i,
    SIGILL
  ],
  // `idiv` by zero or INT_MIN / -1 (#DE), and an invalid float-to-int
  // conversion (FPE_FLTINV). V8 "divide by zero", "remainder by zero",
  // "divide result unrepresentable", "float unrepresentable in integer
  // range"; JSC "Division by zero", "Integer overflow", "Out of bounds Trunc
  // operation"; SpiderMonkey "integer divide by zero", "integer overflow",
  // "invalid conversion to integer".
  [
    /divi(de|sion)|by zero|integer overflow|unrepresentable|conversion to integer|trunc/i,
    SIGFPE
  ],
  // An access outside the process's memory, or a call through a null or
  // wild function pointer. V8 "memory access out of bounds", "table index
  // is out of bounds", "null function"; JSC "Out of bounds memory access",
  // "Out of bounds call_indirect" (a null entry: see the rule above);
  // SpiderMonkey "index out of bounds", "indirect call to null".
  [
    /out of bounds|null/i,
    SIGSEGV
  ]
];
var STACK_OVERFLOW = /call stack size exceeded|too much recursion/i;
function trapSignalOf(error) {
  if (typeof error !== "object" || error === null) return null;
  try {
    const { name, message } = error;
    if (typeof message !== "string") return null;
    if ((name === "RangeError" || name === "InternalError") && STACK_OVERFLOW.test(message)) {
      return SIGSEGV;
    }
    if (!isRuntimeError(error, name)) return null;
    for (const [pattern, signal] of RULES) {
      if (pattern.test(message)) return signal;
    }
    return SIGILL;
  } catch {
    return null;
  }
}
var DESCRIBE_TRAP_LIMIT = 4096;
var DESCRIBE_TRAP_HEAD = 2560;
function capDescription(text) {
  if (text.length <= DESCRIBE_TRAP_LIMIT) return text;
  const marker = "\n    ... (stack cut) ...\n";
  const tail = DESCRIBE_TRAP_LIMIT - DESCRIBE_TRAP_HEAD - marker.length;
  return text.slice(0, DESCRIBE_TRAP_HEAD) + marker + text.slice(-tail);
}
function safeString(value) {
  try {
    return String(value);
  } catch {
    return `unprintable ${typeof value}`;
  }
}
function describeTrap(error) {
  try {
    if (error === void 0) return "no error value";
    if (typeof error !== "object" || error === null) {
      return capDescription(safeString(error));
    }
    const { name, message, stack } = error;
    if (typeof message !== "string") {
      if (typeof stack === "string" && stack.length > 0) {
        return capDescription(stack);
      }
      try {
        return capDescription(JSON.stringify(error) ?? safeString(error));
      } catch {
        return capDescription(safeString(error));
      }
    }
    const head = `${typeof name === "string" ? name : "Error"}: ${message}`;
    const text = typeof stack === "string" && stack.length > 0 ? stack.startsWith(head) ? stack : `${head}
${stack}` : head;
    return capDescription(text);
  } catch {
    return "unprintable error";
  }
}
function isRuntimeError(error, name) {
  return typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError || name === "RuntimeError";
}
function trapCompletionCode(error) {
  const signal = trapSignalOf(error);
  return signal === null ? CHILD_TRAP_EXIT : -(128 + signal);
}

// ../yurtos-kernel/packages/kernel-host-interface-js/asyncify-bridge.ts
var ASYNCIFY_UNWINDING = 1;
var AsyncifyUnwindTrap = class extends Error {
  constructor() {
    super("asyncify unwind trap");
  }
};
var SharedVforkCompleted = class extends Error {
};
var AsyncifyAsyncBridge = class {
  type = "asyncify";
  binarySuffix = "-asyncify";
  // Reflects whether the guest's linear memory is a SharedArrayBuffer.
  // True once initFromInstance() stores a shared-memory import (#764).
  get sharedMemory() {
    return this.memory?.buffer instanceof SharedArrayBuffer;
  }
  // Set by initFromInstance() after the WASM instance is created.
  exports = null;
  // The guest's linear memory — needed to read/write the asyncify
  // save-state buffer when implementing setjmp's capture and
  // longjmp's restore.  Stored alongside the asyncify exports.
  memory = null;
  // Single pending slot — only one async import can be in-flight at a time
  // (WASM is single-threaded; imports don't interleave).
  pendingPromise = null;
  pendingResult = 0;
  // setjmp/longjmp state.  pendingSetjmp holds the env pointer of an
  // in-flight setjmp save (cleared after wrapExport copies the
  // unwound buffer into jmpBufStates).  pendingLongjmp holds the
  // env+val of an in-flight longjmp; cleared by hostSetjmp on rewind
  // after it returns the longjmp value.  jmpBufStates is the lookup
  // table from env pointer to the saved buffer contents.
  pendingSetjmp = null;
  pendingLongjmp = null;
  pendingFork = false;
  pendingForkReturn = null;
  pendingForkCallerTid = 1;
  pendingForkDecision = {
    mode: "fork"
  };
  pendingForkChildStackTop = null;
  pendingForkMemoryBytes = null;
  pendingForkExecutionState = null;
  executionRegistry = null;
  /** Instrumented startup modules (instances fixed at startup). */
  startupParticipants = [];
  /** Runtime-loaded modules, live: loaders register and retire them. */
  runtimeParticipants = null;
  jmpBufStates = /* @__PURE__ */ new Map();
  forkController = null;
  sealController = null;
  /** The envelope of the `yurt.syscall` a seal unwind was started at. */
  pendingSeal = null;
  pendingSealExecutionState = null;
  /** Armed by `startSealRewind`; consumed by `finishSealRewind` at the
   *  `yurt.syscall` call site the rewind lands on. */
  sealRewinding = false;
  activeSharedVforks = [];
  resetBufferHeader() {
    if (!this.exports || !this.memory || this.exports.dataSize < 8) return;
    const view = new DataView(this.memory.buffer);
    view.setUint32(this.exports.dataAddr, this.exports.dataAddr + 8, true);
    view.setUint32(this.exports.dataAddr + 4, this.exports.dataAddr + this.exports.dataSize, true);
  }
  /**
   * Call once after instantiation.
   *
   * @param instance  The WebAssembly.Instance with asyncify exports.
   * @param dataAddr  Address of the pre-allocated asyncify data buffer (≥16 bytes
   *                  header + stack-save area).  The caller must have already
   *                  written the [start, end] header into WASM memory.
   */
  initFromInstance(instance, dataAddr, dataSize = 0, importedMemory, executionBindings, runtimeParticipants) {
    const exp = instance.exports;
    this.exports = {
      startUnwind: exp.asyncify_start_unwind,
      stopUnwind: exp.asyncify_stop_unwind,
      startRewind: exp.asyncify_start_rewind,
      stopRewind: exp.asyncify_stop_rewind,
      getState: exp.asyncify_get_state,
      dataAddr,
      dataSize,
      stackPointer: exp.__stack_pointer instanceof WebAssembly.Global ? exp.__stack_pointer : null
    };
    this.memory = exp.memory instanceof WebAssembly.Memory ? exp.memory : importedMemory ?? null;
    if (!this.memory) throw new Error("continuation: missing memory");
    const bindings = executionBindings ?? mainExecutionBindings(instance, this.memory);
    this.executionRegistry = new ModuleExecutionRegistry(this.memory, bindings);
    this.startupParticipants = bindings.modules.filter(({ identity, instance: instance2 }) => identity.kind !== "main" && asyncifySurface(instance2) === "full");
    this.runtimeParticipants = runtimeParticipants ?? null;
  }
  /** Participants other than main, in registration order. */
  sideParticipants() {
    const runtime = this.runtimeParticipants?.list() ?? [];
    return runtime.length === 0 ? this.startupParticipants : [
      ...this.startupParticipants,
      ...runtime
    ];
  }
  // Each transition starts or stops main and then every side participant over
  // the calling thread's buffer. With only main registered this is exactly the
  // single-instance call it replaced.
  asyncifyStartUnwind() {
    const exps = this.exports;
    exps.startUnwind(exps.dataAddr);
    const side = this.sideParticipants();
    if (side.length === 0) return;
    this.failClosedStart(() => transitionModules(side, "unwind", exps.dataAddr), "stopUnwind", side);
  }
  // A participant that fails to start leaves main (and any participant already
  // started) in the new state, which the drive loops would take for a real
  // unwind or rewind. Put every module back to normal, then surface the error.
  failClosedStart(start, stop, side) {
    try {
      start();
    } catch (error) {
      const exps = this.exports;
      try {
        if (stop === "stopUnwind") exps.stopUnwind();
        else exps.stopRewind();
      } catch {
      }
      for (const control of side) {
        try {
          transitionModules([
            control
          ], stop, exps.dataAddr);
        } catch {
        }
      }
      throw error;
    }
  }
  asyncifyStopUnwind() {
    const exps = this.exports;
    exps.stopUnwind();
    const side = this.sideParticipants();
    if (side.length > 0) transitionModules(side, "stopUnwind", exps.dataAddr);
  }
  asyncifyStartRewind() {
    const exps = this.exports;
    exps.startRewind(exps.dataAddr);
    const side = this.sideParticipants();
    if (side.length === 0) return;
    this.failClosedStart(() => transitionModules(side, "rewind", exps.dataAddr), "stopRewind", side);
  }
  asyncifyStopRewind() {
    const exps = this.exports;
    exps.stopRewind();
    const side = this.sideParticipants();
    if (side.length > 0) transitionModules(side, "stopRewind", exps.dataAddr);
  }
  setForkController(controller) {
    this.forkController = controller;
  }
  isUnwinding() {
    return this.exports?.getState() === ASYNCIFY_UNWINDING;
  }
  /**
   * host_setjmp(envPtr) — POSIX setjmp implemented over Asyncify.
   *
   * First call (state=NORMAL): record the env pointer and trigger an
   * unwind so the asyncify buffer is populated with the current C
   * call stack.  wrapExport's driver loop copies the unwound buffer
   * into jmpBufStates[envPtr] then immediately rewinds — when the
   * rewind reaches this very call site, host_setjmp is re-entered
   * with state=REWINDING and returns 0 (the standard setjmp first
   * return).
   *
   * Rewind under longjmp (state=REWINDING + pendingLongjmp set):
   * stopRewind, return the longjmp value, clear pendingLongjmp.
   * The wasm side sees setjmp return val.
   */
  hostSetjmp = (envPtr) => {
    if (!this.exports) {
      return 0;
    }
    const exps = this.exports;
    if (exps.getState() === 2) {
      this.asyncifyStopRewind();
      this.resetBufferHeader();
      if (this.pendingLongjmp) {
        const val = this.pendingLongjmp.val;
        this.pendingLongjmp = null;
        return val;
      }
      return 0;
    }
    this.pendingSetjmp = envPtr;
    this.resetBufferHeader();
    this.asyncifyStartUnwind();
    return 0;
  };
  /**
   * host_longjmp(envPtr, val) — POSIX longjmp over Asyncify.
   *
   * Trigger an unwind; wrapExport's driver loop will detect
   * pendingLongjmp, replace the asyncify buffer with the saved
   * snapshot (taken at setjmp time), and rewind.  The rewind walks
   * back into setjmp's import call, which returns val.
   *
   * From the C program's perspective the call doesn't return —
   * yurt_setjmp.c follows the host_longjmp invocation with
   * __builtin_unreachable, and asyncify intercepts before that
   * instruction is ever reached.
   */
  hostLongjmp = (envPtr, val) => {
    if (!this.exports) {
      throw new Error("longjmp: bridge not initialized (no matching setjmp)");
    }
    if (!this.jmpBufStates.has(envPtr)) {
      throw new Error(`longjmp: unknown jmp_buf @0x${envPtr.toString(16)}`);
    }
    this.pendingLongjmp = {
      envPtr,
      val
    };
    this.resetBufferHeader();
    this.asyncifyStartUnwind();
  };
  hostFork = (callerTid, decision) => {
    if (!this.exports) return -38;
    const exps = this.exports;
    if (exps.getState() === 2) {
      this.asyncifyStopRewind();
      this.resetBufferHeader();
      if (this.pendingForkChildStackTop !== null && exps.stackPointer !== null) {
        this.executionRegistry.enterCallerStack(this.pendingForkChildStackTop);
        this.pendingForkChildStackTop = null;
      }
      const value = this.pendingForkReturn ?? -11;
      this.pendingForkReturn = null;
      return value;
    }
    let executionState;
    try {
      executionState = this.executionRegistry.capture();
    } catch (error) {
      if (error instanceof InvalidModuleExecutionState) return -11;
      throw error;
    }
    this.pendingFork = true;
    this.pendingForkCallerTid = callerTid;
    this.pendingForkDecision = decision;
    this.pendingForkMemoryBytes = decision.mode === "vfork_shared" ? null : this.memory ? new Uint8Array(this.memory.buffer).slice() : null;
    this.pendingForkExecutionState = executionState;
    this.resetBufferHeader();
    this.asyncifyStartUnwind();
    return 0;
  };
  restoreForkSnapshot(snapshot, forkReturn) {
    this.restoreContinuation(snapshot);
    this.pendingForkReturn = forkReturn;
    this.pendingForkChildStackTop = snapshot.fork.childStackTop ?? null;
  }
  startForkRewind() {
    if (!this.exports) throw new Error("fork: bridge not initialized");
    this.asyncifyStartRewind();
  }
  /**
   * Throws `InvalidModuleExecutionState` when the execution state cannot be
   * captured here (stack pointer outside the thread's bounds, ...). Called
   * where a seal is withheld, before the guest is told to reach
   * `host_checkpoint`, so the refusal is a clean seal failure and not a trap
   * at the unwind.
   */
  validateSealExecutionState() {
    if (!this.executionRegistry) {
      throw new Error("seal: bridge not initialized");
    }
    this.executionRegistry.capture();
  }
  setSealController(controller) {
    this.sealController = controller;
  }
  /**
   * Start a seal unwind at `host_checkpoint` after the ordinary import has
   * withheld a request. The drive loop captures the unwound frames, parks,
   * and rewinds here. The owner consumes its pending record and returns one
   * so the guest wrapper reissues the syscall from its saved locals.
   */
  hostSeal(checkpoint) {
    if (!this.exports) throw new Error("seal: bridge not initialized");
    this.pendingSealExecutionState = this.executionRegistry.capture();
    this.pendingSeal = structuredClone(checkpoint);
    this.resetBufferHeader();
    try {
      this.asyncifyStartUnwind();
    } catch (error) {
      this.pendingSealExecutionState = null;
      this.pendingSeal = null;
      throw error;
    }
  }
  /** Whether the import being entered is the landing site of a seal rewind. */
  sealRewindPending() {
    return this.sealRewinding && this.exports?.getState() === 2;
  }
  /** Stop the seal rewind at its landing site; the caller then proceeds as
   *  if the guest had called it for the first time. */
  finishSealRewind() {
    if (!this.exports) throw new Error("seal: bridge not initialized");
    this.sealRewinding = false;
    this.asyncifyStopRewind();
    this.resetBufferHeader();
  }
  /** Install a sealed continuation into a fresh instance's memory and
   *  globals — `restoreForkSnapshot` without a fork return value. */
  restoreSealSnapshot(snapshot) {
    this.restoreContinuation(snapshot);
  }
  restoreContinuation(snapshot) {
    if (!this.executionRegistry) {
      throw new Error("continuation: bridge not initialized");
    }
    this.executionRegistry.validate(snapshot.executionState);
    if (this.memory && snapshot.continuationBytes.byteLength > 0) {
      new Uint8Array(this.memory.buffer, snapshot.dataAddr, snapshot.continuationBytes.byteLength).set(snapshot.continuationBytes);
    }
    this.jmpBufStates = new Map(snapshot.jmpBufStates.map(([ptr, state]) => [
      ptr,
      {
        savedHigh: state.savedHigh,
        savedData: state.savedData.slice(),
        stackPointer: state.stackPointer
      }
    ]));
    this.executionRegistry.restore(snapshot.executionState);
  }
  startSealRewind() {
    if (!this.exports) throw new Error("seal: bridge not initialized");
    this.sealRewinding = true;
    this.asyncifyStartRewind();
  }
  /** The continuation of a completed seal unwind. Unlike the fork snapshot
   *  the memory is copied AFTER the unwind, so the Asyncify data region
   *  already holds the continuation; the explicit copy is what a restore
   *  installs before the rest of the image is in place. */
  snapshotSealContinuation(checkpoint) {
    if (!this.exports || !this.memory) {
      throw new Error("seal: bridge not initialized");
    }
    const memoryBytes = new Uint8Array(this.memory.buffer).slice();
    const executionState = this.pendingSealExecutionState ?? void 0;
    this.pendingSealExecutionState = null;
    return {
      ...this.snapshotContinuation(memoryBytes, memoryBytes.byteLength / 65536, executionState),
      checkpoint
    };
  }
  snapshotContinuation(memoryBytes, memoryPages, executionState) {
    if (!this.exports || !this.memory) {
      throw new Error("continuation: bridge not initialized");
    }
    const continuationBytes = new Uint8Array(this.memory.buffer, this.exports.dataAddr, this.exports.dataSize).slice();
    return {
      memoryBytes,
      memoryPages,
      executionState: executionState ?? this.executionRegistry.capture(),
      dataAddr: this.exports.dataAddr,
      dataSize: this.exports.dataSize,
      continuationBytes,
      jmpBufStates: Array.from(this.jmpBufStates.entries()).map(([ptr, state]) => [
        ptr,
        {
          savedHigh: state.savedHigh,
          savedData: state.savedData.slice(),
          stackPointer: state.stackPointer
        }
      ])
    };
  }
  /** Drop a recorded setjmp save-state.  Optional cleanup hook for
   *  callers that know a jmp_buf has gone out of scope. */
  forgetJmpBuf(envPtr) {
    this.jmpBufStates.delete(envPtr);
  }
  /** Read [dataAddr+0]..[start_offset] of the asyncify buffer into
   *  jmpBufStates[envPtr].  Called by the driver loop after a
   *  setjmp-triggered unwind has populated the buffer. */
  captureBuffer(envPtr) {
    if (!this.exports || !this.memory) return;
    const view = new DataView(this.memory.buffer);
    const high = view.getUint32(this.exports.dataAddr, true);
    const bufStart = this.exports.dataAddr + 8;
    const dataLen = high - bufStart;
    const savedData = new Uint8Array(this.memory.buffer, bufStart, dataLen).slice();
    const stackPointer = this.exports.stackPointer?.value ?? null;
    this.jmpBufStates.set(envPtr, {
      savedHigh: high,
      savedData,
      stackPointer
    });
  }
  /** Write jmpBufStates[envPtr]'s saved bytes back into the asyncify
   *  buffer and reset the start offset to the saved high-water mark.
   *  Called before triggering a longjmp rewind. */
  restoreBuffer(envPtr) {
    if (!this.exports || !this.memory) return;
    const state = this.jmpBufStates.get(envPtr);
    if (!state) return;
    const view = new DataView(this.memory.buffer);
    new Uint8Array(this.memory.buffer, this.exports.dataAddr + 8, state.savedData.length).set(state.savedData);
    view.setUint32(this.exports.dataAddr, state.savedHigh, true);
    if (state.stackPointer !== null && this.exports.stackPointer) {
      this.exports.stackPointer.value = state.stackPointer;
    }
  }
  snapshotForkContinuation() {
    if (!this.exports || !this.memory) {
      throw new Error("fork: bridge not initialized");
    }
    const sharedVfork = this.pendingForkDecision.mode === "vfork_shared";
    const pending = this.pendingForkMemoryBytes;
    this.pendingForkMemoryBytes = null;
    const memoryBytes = sharedVfork ? new Uint8Array(0) : pending ?? new Uint8Array(this.memory.buffer).slice();
    if (!sharedVfork && pending && this.exports.dataSize > 0) {
      memoryBytes.set(new Uint8Array(this.memory.buffer, this.exports.dataAddr, this.exports.dataSize), this.exports.dataAddr);
    }
    return {
      callerTid: this.pendingForkCallerTid,
      fork: this.pendingForkDecision,
      ...this.snapshotContinuation(memoryBytes, memoryBytes.byteLength / 65536, this.pendingForkExecutionState ?? void 0)
    };
  }
  /**
   * Wrap an import function.  The returned sync function is used as a WASM
   * import.  It returns immediately if the underlying fn is synchronous.
   * If fn returns a Promise the wrapper starts an asyncify unwind so WASM
   * suspends until the Promise resolves.  `asyncSentinel` must use the WASM
   * result type (`0n` for an i64/BigInt import, `0` for an i32 import), since
   * the value crosses the import boundary before the unwind completes.
   */
  wrapImport(fn, asyncSentinel) {
    return (...args) => {
      if (!this.exports) {
        const ret2 = fn(...args);
        if (ret2 instanceof Promise) return asyncSentinel;
        return ret2;
      }
      const exps = this.exports;
      if (exps.getState() === 2) {
        this.asyncifyStopRewind();
        this.resetBufferHeader();
        return this.pendingResult;
      }
      const ret = fn(...args);
      if (ret instanceof Promise) {
        this.pendingPromise = ret.then((r) => {
          this.pendingResult = r;
        });
        this.resetBufferHeader();
        this.asyncifyStartUnwind();
        return asyncSentinel;
      }
      return ret;
    };
  }
  /**
   * Wrap a WASM export so the host can drive the unwind/rewind loop.
   *
   * This is the asyncify-scheduler variant: async imports also use
   * Asyncify (via wrapImport, which suspends on Promise returns by
   * triggering an unwind), so the loop has to handle three reasons
   * for unwinding:
   *   - pendingSetjmp     : host_setjmp was called; capture the
   *                         unwound buffer into jmpBufStates and
   *                         rewind back to the setjmp call site.
   *   - pendingLongjmp    : host_longjmp was called; restore the
   *                         buffer saved at setjmp time and rewind
   *                         (the rewind walks back into host_setjmp,
   *                         which returns the longjmp value).
   *   - pendingPromise    : an async host import returned a Promise;
   *                         await it, then rewind so the import sees
   *                         state=REWINDING and returns the result.
   *
   * Used when JSPI (the preferred scheduler) is unavailable on the
   * host — see wrapExportJspi for the JSPI-scheduler variant.
   */
  wrapExport(fn) {
    return async (...args) => {
      const exps = this.exports;
      const invoke = () => {
        try {
          return fn(...args);
        } catch (e) {
          if (e instanceof AsyncifyUnwindTrap && exps.getState() === 1) {
            return 0;
          }
          const active = this.activeSharedVforks.at(-1);
          if (active && this.forkController?.finishSharedVfork) {
            this.forkController.finishSharedVfork(e);
            this.activeSharedVforks.pop();
            this.restoreForkSnapshot(active.snapshot, active.parentReturn);
            this.startForkRewind();
            return invoke();
          }
          throw e;
        }
      };
      let result = invoke();
      while (exps.getState() === 1) {
        this.asyncifyStopUnwind();
        if (this.pendingFork) {
          this.pendingFork = false;
          const snapshot = this.snapshotForkContinuation();
          const sharedVfork = snapshot.fork.mode === "vfork_shared";
          const childPid = sharedVfork ? this.forkController?.startSharedVfork?.(snapshot) ?? -38 : this.forkController ? this.forkController.forkFromContinuation(snapshot) : -38;
          if (sharedVfork && childPid >= 0) {
            this.activeSharedVforks.push({
              snapshot,
              parentReturn: childPid
            });
          }
          this.pendingForkMemoryBytes = null;
          this.pendingForkExecutionState = null;
          this.pendingForkDecision = {
            mode: "fork"
          };
          this.pendingForkReturn = sharedVfork && childPid >= 0 ? 0 : childPid;
          this.asyncifyStartRewind();
          result = invoke();
        } else if (this.pendingSetjmp !== null) {
          const envPtr = this.pendingSetjmp;
          this.pendingSetjmp = null;
          this.captureBuffer(envPtr);
          this.asyncifyStartRewind();
          result = invoke();
        } else if (this.pendingLongjmp !== null) {
          this.restoreBuffer(this.pendingLongjmp.envPtr);
          this.asyncifyStartRewind();
          result = invoke();
        } else {
          await this.pendingPromise;
          this.asyncifyStartRewind();
          result = fn(...args);
        }
      }
      return result;
    };
  }
  wrapExportSync(fn) {
    return (...args) => fn(...args);
  }
  /**
   * SYNCHRONOUS driver — the JS-host sibling of the Rust port's
   * `drive_with_asyncify` (`asyncify_bridge.rs:405-462`, itself the
   * documented port of this file's `wrapExport` :448-485). Same
   * re-invoke loop, same branch order (fork → setjmp → longjmp →
   * async-import), driven synchronously because the JS host's
   * `_start`/spawn-wait pump (#129/#206) is synchronous and a forked
   * child's own `syscall_wait` uses that sync non-asyncify pump (NOT a
   * re-park / async suspension). The async-import-unwind `else`
   * throws, exactly mirroring the Rust driver's
   * `else => Err("asyncify unwind with no pending
   * setjmp/longjmp/fork cause")` (`asyncify_bridge.rs:454-458`):
   * setjmp/longjmp/fork are the only asyncify causes on this path, so
   * the loop never needs to `await` and stays byte-parity-locked to
   * the Rust host. This is a faithful port of `wrapExport`'s loop,
   * not a redesign — symbol-diffable against both `wrapExport` and
   * `drive_with_asyncify`.
   */
  wrapExportSyncDrive(fn) {
    return (...args) => {
      const exps = this.exports;
      const invoke = () => {
        try {
          return fn(...args);
        } catch (e) {
          if (e instanceof AsyncifyUnwindTrap && exps.getState() === 1) {
            return 0;
          }
          const active = this.activeSharedVforks.at(-1);
          if (active && this.forkController?.finishSharedVfork) {
            this.forkController.finishSharedVfork(e);
            this.activeSharedVforks.pop();
            this.restoreForkSnapshot(active.snapshot, active.parentReturn);
            this.startForkRewind();
            return invoke();
          }
          throw e;
        }
      };
      let result = invoke();
      for (; ; ) {
        while (exps.getState() === 1) {
          this.asyncifyStopUnwind();
          if (this.pendingFork) {
            this.pendingFork = false;
            const snapshot = this.snapshotForkContinuation();
            const sharedVfork = snapshot.fork.mode === "vfork_shared";
            const childPid = sharedVfork ? this.forkController?.startSharedVfork?.(snapshot) ?? -38 : this.forkController ? this.forkController.forkFromContinuation(snapshot) : -38;
            if (sharedVfork && childPid >= 0) {
              this.activeSharedVforks.push({
                snapshot,
                parentReturn: childPid
              });
            }
            this.pendingForkMemoryBytes = null;
            this.pendingForkExecutionState = null;
            this.pendingForkDecision = {
              mode: "fork"
            };
            this.pendingForkReturn = sharedVfork && childPid >= 0 ? 0 : childPid;
            this.asyncifyStartRewind();
            result = invoke();
          } else if (this.pendingSetjmp !== null) {
            const envPtr = this.pendingSetjmp;
            this.pendingSetjmp = null;
            this.captureBuffer(envPtr);
            this.asyncifyStartRewind();
            result = invoke();
          } else if (this.pendingLongjmp !== null) {
            this.restoreBuffer(this.pendingLongjmp.envPtr);
            this.asyncifyStartRewind();
            result = invoke();
          } else if (this.pendingSeal !== null) {
            const cursor = this.pendingSeal;
            this.pendingSeal = null;
            if (!this.sealController) {
              throw new Error("asyncify seal unwind with no seal controller");
            }
            this.sealController.seal(this.snapshotSealContinuation(cursor));
            this.sealRewinding = true;
            this.asyncifyStartRewind();
            result = invoke();
          } else {
            throw new Error("asyncify unwind with no pending setjmp/longjmp/fork/seal cause");
          }
        }
        const active = this.activeSharedVforks.at(-1);
        if (!active || !this.forkController?.finishSharedVfork) return result;
        this.forkController.finishSharedVfork(new SharedVforkCompleted());
        this.activeSharedVforks.pop();
        this.restoreForkSnapshot(active.snapshot, active.parentReturn);
        this.startForkRewind();
        result = invoke();
      }
    };
  }
  /**
   * JSPI-scheduler variant of wrapExport.  fn is the WebAssembly
   * .promising-wrapped export, so async-import suspends propagate
   * naturally as Promise resolutions through fn's return.  We only
   * have to catch Asyncify unwinds (setjmp/longjmp) — pendingPromise
   * is never set in this path because async imports don't go through
   * bridge.wrapImport when JSPI handles them.
   */
  wrapExportJspi(fn) {
    return async (...args) => {
      const exps = this.exports;
      let result = await fn(...args);
      while (exps.getState() === 1) {
        this.asyncifyStopUnwind();
        if (this.pendingSetjmp !== null) {
          const envPtr = this.pendingSetjmp;
          this.pendingSetjmp = null;
          this.captureBuffer(envPtr);
        } else if (this.pendingLongjmp !== null) {
          this.restoreBuffer(this.pendingLongjmp.envPtr);
        } else {
          throw new Error("asyncify unwound without a setjmp/longjmp pending; async-import suspensions should go through JSPI on this path");
        }
        this.asyncifyStartRewind();
        result = await fn(...args);
      }
      return result;
    };
  }
};

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/relay_completion.ts
var COMPLETION_STATUS_SETTLED = 1;
var COMPLETION_KIND_PROCESS = 0;
var COMPLETION_KIND_THREAD = 1;
function readThreadAdmission(completion) {
  const len = Atomics.load(completion, 4);
  if (len === 0) return void 0;
  return {
    addr: Atomics.load(completion, 3),
    len
  };
}
function settleCompletion(completion, code, kind = COMPLETION_KIND_PROCESS) {
  Atomics.store(completion, 1, code);
  Atomics.store(completion, 2, kind);
  Atomics.store(completion, 0, COMPLETION_STATUS_SETTLED);
  Atomics.notify(completion, 0);
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/startup_resident_handles.ts
var RESIDENT_HANDLE_BASE = 1073741824;
var RESIDENT_HANDLE_LIMIT = 268435456;
function residentHandle(generation) {
  return RESIDENT_HANDLE_BASE + (-generation - 1);
}
function residentGeneration(handle) {
  return Number.isInteger(handle) && handle >= RESIDENT_HANDLE_BASE && handle < RESIDENT_HANDLE_BASE + RESIDENT_HANDLE_LIMIT ? -(handle - RESIDENT_HANDLE_BASE) - 1 : void 0;
}
function residentLookup(byGeneration) {
  return (handle) => {
    const generation = residentGeneration(handle);
    return generation === void 0 ? void 0 : byGeneration(generation);
  };
}

// ../yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/worker_bootstrap.ts
var RUNTIME_LINK_OPS = Symbol("yurt.runtimeLinkOps");
var asyncifyBridge = new AsyncifyAsyncBridge();
var asyncifyReady = false;
var READY_OK = 1;
var READY_FAILED = 2;
var RELAY_POLL_MS = 50;
var GUEST_SYSCALL_WAIT_PARKED_RETRY_CAP = 1e3;
var GUEST_SYSCALL_THREAD_EXIT_PREPARE_RETRY_CAP = 16;
var GUEST_SYSCALL_MODULE_REDISPATCH_RETRY_CAP = 1e3;
var PthreadStartHandoff = class extends Error {
  fnPtr;
  arg;
  constructor(fnPtr, arg) {
    super("pthread start routine handoff"), this.fnPtr = fnPtr, this.arg = arg;
    this.name = "PthreadStartHandoff";
  }
};
var pthreadStartHandoffArmed = false;
var LINUX_NR_RT_SIGTIMEDWAIT = 128;
var ENOSYS2 = 38;
function memoryView(memory) {
  return new Uint8Array(memory.buffer);
}
function guestRangeOk(view, ptr, len) {
  return len === 0 || ptr + len <= view.byteLength;
}
function writeStartupSizes(memory, values, countPtr, sizePtr) {
  countPtr >>>= 0;
  sizePtr >>>= 0;
  const view = memoryView(memory);
  const size = values.reduce((total, value) => total + value.byteLength + 1, 0);
  if (!guestRangeOk(view, countPtr, 4) || !guestRangeOk(view, sizePtr, 4)) {
    return EFAULT;
  }
  new DataView(view.buffer).setUint32(countPtr, values.length, true);
  new DataView(view.buffer).setUint32(sizePtr, size, true);
  return 0;
}
function writeStartupValues(memory, values, pointersPtr, bufferPtr) {
  pointersPtr >>>= 0;
  bufferPtr >>>= 0;
  const view = memoryView(memory);
  const size = values.reduce((total, value) => total + value.byteLength + 1, 0);
  if (!guestRangeOk(view, pointersPtr, values.length * 4) || !guestRangeOk(view, bufferPtr, size)) return EFAULT;
  const data = new DataView(view.buffer);
  let offset = 0;
  values.forEach((value, index) => {
    data.setUint32(pointersPtr + index * 4, bufferPtr + offset, true);
    view.set(value, bufferPtr + offset);
    view[bufferPtr + offset + value.byteLength] = 0;
    offset += value.byteLength + 1;
  });
  return 0;
}
function checkYurtImportTypes(module, types) {
  for (const imported of WebAssembly.Module.imports(module)) {
    if (imported.module !== "yurt") continue;
    if (imported.kind !== "function") {
      throw new Error(`yurt.${imported.name} is a ${imported.kind} import`);
    }
    const want = YURT_IMPORT_TYPES.get(imported.name);
    if (want !== void 0 && types?.[imported.name] !== want) {
      throw new Error(`yurt.${imported.name} has type ${types?.[imported.name]}, the contract ${want}`);
    }
  }
}
function buildGuestImports(module, memory, argv, processEnv, auxv, getWasmTable, runtimeLinkPlan, getMainExport, fetchRuntimeModule, refreshRuntimeLinkPlan, publishRuntimeLinkRecord, runtimeLibrarySearch, retireRuntimeLinkRecord, retainRuntimeLinkRecord, mutateRuntimeLinkRecords, reserveRuntimeLinkLayout, abortRuntimeLinkLayout, reserveMainFunctionSlot, moduleIdentityPrefix = "worker", bytesTransport, reportConstructed) {
  const auxvOk = auxvValid(auxv);
  const yurt = {
    args_sizes_get: (countPtr, sizePtr) => writeStartupSizes(memory, argv, countPtr, sizePtr),
    args_get: (pointersPtr, bufferPtr) => writeStartupValues(memory, argv, pointersPtr, bufferPtr),
    environ_sizes_get: (countPtr, sizePtr) => writeStartupSizes(memory, processEnv, countPtr, sizePtr),
    environ_get: (pointersPtr, bufferPtr) => writeStartupValues(memory, processEnv, pointersPtr, bufferPtr),
    auxv_sizes_get: (countPtr) => {
      countPtr >>>= 0;
      if (!auxvOk) return EINVAL;
      const view = memoryView(memory);
      if (!guestRangeOk(view, countPtr, 4)) return EFAULT;
      new DataView(view.buffer).setUint32(countPtr, auxv.length, true);
      return 0;
    },
    auxv_get: (pairsPtr, capacity) => {
      pairsPtr >>>= 0;
      if (!auxvOk || capacity >>> 0 < auxv.length) return EINVAL;
      const view = memoryView(memory);
      if (!guestRangeOk(view, pairsPtr, auxv.length * 8)) return EFAULT;
      const data = new DataView(view.buffer);
      auxv.forEach((entry, index) => {
        data.setUint32(pairsPtr + index * 8, entry.tag, true);
        data.setUint32(pairsPtr + index * 8 + 4, entry.value, true);
      });
      return 0;
    },
    // These imports must exist for module linking. Real `yurt.syscall`
    // dispatch is wired in per-caller below (`handleInit` /
    // `handleThreadInit`), once the mailbox/pendingWake for this instance
    // exist — mirrors how `env.sys_setrlimit` is wired below. For
    // `syscall` this placeholder only satisfies module linking before that
    // assignment runs, and is never actually invoked (`_start`/thread entry
    // only runs after the real implementation has replaced it).
    // Bound to the bridge's stable arrow-function properties, so wiring
    // them here (before the bridge is initialized against an instance) is
    // safe: `hostSetjmp` explicitly tolerates the uninitialized case, and
    // `initAsyncifyBridge` fills in exports/memory later in `handleInit`.
    // These MUST exist in the import table or any setjmp/longjmp guest
    // fails to instantiate with a LinkError.
    host_setjmp: asyncifyBridge.hostSetjmp,
    host_longjmp: asyncifyBridge.hostLongjmp,
    host_checkpoint: () => 0,
    syscall: () => BigInt(-ENOSYS2),
    // Real fork/vfork/clone/clone3. Wired in `handleInit`/`handleThreadInit`
    // once this instance's mailbox exists, exactly like `syscall` above;
    // this placeholder only satisfies module linking before that runs.
    syscall_fork_family: () => BigInt(-ENOSYS2),
    // No signal-delivery entries. #1737 completed the musl signal cutover:
    // check_signals, signal_raise and signal_handler_done now ride the
    // `yurt.syscall` conduit as natural private syscall arms, exactly as
    // sigaction did in #1723. `abi-syscall-dispatch.test.ts` ("signal delivery
    // uses only natural private syscall arms") asserts this file does not
    // mention any of the three names.
    //
    // Merge note: this branch carried a `() => 0` stub here; main's real
    // implementation (#1779) wins. The comment above is about the absence of
    // signal entries in this object, not about the start routine, so it
    // survives the resolution.
    host_call_start_routine: (fnPtr, arg) => {
      if (pthreadStartHandoffArmed) {
        throw new PthreadStartHandoff(fnPtr >>> 0, arg >>> 0);
      }
      const routine = getWasmTable?.()?.get(fnPtr >>> 0);
      return typeof routine === "function" ? Number(routine(arg >>> 0)) | 0 : 0;
    }
  };
  const env = {
    memory,
    ...unwindStubImports()
  };
  for (const imported of WebAssembly.Module.imports(module)) {
    if (imported.kind !== "function") continue;
    if (imported.module === "yurt" && !(imported.name in yurt)) {
      const name = imported.name;
      yurt[name] = () => unimplementedGuestImportResult(name, ENOSYS2);
    }
  }
  if (runtimeLinkPlan !== void 0) {
    installRuntimeLinkImports({
      env,
      yurt
    }, runtimeLinkPlan, memory, getWasmTable, getMainExport, fetchRuntimeModule, refreshRuntimeLinkPlan, publishRuntimeLinkRecord, runtimeLibrarySearch, retireRuntimeLinkRecord, retainRuntimeLinkRecord, mutateRuntimeLinkRecords, reserveRuntimeLinkLayout, abortRuntimeLinkLayout, reserveMainFunctionSlot, moduleIdentityPrefix, bytesTransport, reportConstructed);
  }
  return {
    env,
    yurt
  };
}
function workerCwd(mailbox, pendingWake, env) {
  let cwd = env.map((entry) => new TextDecoder().decode(entry)).find((entry) => entry.startsWith("PWD="))?.slice(4) || "/";
  const cwdResult = relayStructuredSyscall(mailbox, pendingWake, METHOD.KERNEL_FS_GETCWD, new Uint8Array(), 4e3);
  const cwdBytes = cwdResult.response.subarray(0, Number(cwdResult.rc));
  const end = cwdBytes.at(-1) === 0 ? cwdBytes.length - 1 : cwdBytes.length;
  if (cwdResult.rc > 0n) {
    cwd = new TextDecoder().decode(cwdBytes.subarray(0, end)) || "/";
  }
  return cwd;
}
function installRuntimeLinkImports(imports, plan, memory, getWasmTable, getMainExport, fetchRuntimeModule, refreshRuntimeLinkPlan, _publishRuntimeLinkRecord, runtimeLibrarySearch, _retireRuntimeLinkRecord, _retainRuntimeLinkRecord, mutateRuntimeLinkRecords, reserveRuntimeLinkLayout, abortRuntimeLinkLayout, reserveMainFunctionSlot, moduleIdentityPrefix = "worker", bytesTransport, reportConstructed) {
  const object = imports;
  const yurt = object.yurt ?? (object.yurt = {});
  const librarySearch = runtimeLibrarySearch ?? {
    policy: {
      secure: true
    },
    cwd: () => "/"
  };
  const cwdCache = createCwdCache(librarySearch.cwd);
  const searchCandidates = (path) => libraryCandidates(path, librarySearch.policy, needsCwd(path, librarySearch.policy) ? cwdCache.get() : "/");
  const handles = /* @__PURE__ */ new Map();
  const instances = /* @__PURE__ */ new Map();
  const asyncifyParticipants = new ModuleAsyncifyParticipants();
  const forgetInstance = (generation) => {
    instances.delete(generation);
    asyncifyParticipants.retire({
      kind: "runtime",
      generation,
      path: ""
    });
  };
  const refCounts = /* @__PURE__ */ new Map();
  const locallyPublished = /* @__PURE__ */ new Set();
  const fetchedGenerations = /* @__PURE__ */ new Set();
  const initializedGenerations = /* @__PURE__ */ new Set();
  let runCollector;
  const markerOf = (member) => constructedMarker(() => reportConstructed?.(member));
  const runSlots = /* @__PURE__ */ new Map();
  const pendingRuns = /* @__PURE__ */ new Map();
  let nextRunId = 1;
  const ownedFetchedDependencies = /* @__PURE__ */ new Map();
  const closedGenerations = /* @__PURE__ */ new Set();
  const defaultChain = [];
  const mainFunctionSymbols = /* @__PURE__ */ new Map();
  const providedModuleBytes = /* @__PURE__ */ new Map();
  let nextProvidedModuleId = 1;
  const errors = {
    value: null
  };
  const materialized = /* @__PURE__ */ new Map();
  const functionSlots = /* @__PURE__ */ new Map();
  const materializing = /* @__PURE__ */ new Set();
  const compiledModules = /* @__PURE__ */ new Map();
  class ModuleBytesGone extends Error {
  }
  class RuntimeLinkRefreshFailed extends Error {
    /** The coordinator's `EAGAIN` (or a read with no errno): asking again
     *  may succeed. Any other errno is final. */
    transient;
    constructor(errno) {
      super("the coordinator's plan could not be read");
      this.transient = errno === null || errno === -EAGAIN;
    }
  }
  let bytesGone = false;
  const bytesOf = (entry) => {
    const wanted = entry.bytesLength ?? entry.bytes.byteLength;
    if (entry.bytes.byteLength >= wanted) return entry.bytes;
    if (!bytesTransport) {
      throw new Error(`module bytes of ${entry.path} are not available`);
    }
    const assembled = new Uint8Array(wanted);
    let offset = 0;
    while (offset < wanted) {
      const chunk = bytesTransport.get(entry.path, entry.generation, offset, Math.min(wanted - offset, MODULE_BYTES_CHUNK));
      if (typeof chunk === "number") {
        if (chunk === -ENOENT) throw new ModuleBytesGone(entry.path);
        throw new Error(`reading ${entry.path} failed (${chunk})`);
      }
      if (chunk.byteLength === 0) {
        throw new Error(`reading ${entry.path} made no progress`);
      }
      if (offset + chunk.byteLength > wanted) {
        throw new Error(`reading ${entry.path} returned too many bytes`);
      }
      assembled.set(chunk, offset);
      offset += chunk.byteLength;
    }
    entry.bytes = assembled;
    return assembled;
  };
  const moduleOf = (entry) => {
    let module = compiledModules.get(entry.generation);
    if (!module) {
      module = new WebAssembly.Module(bytesOf(entry));
      compiledModules.set(entry.generation, module);
    }
    return module;
  };
  const residents = () => [
    ...startupResidents.get(memory)?.values() ?? []
  ];
  const residentById = (id) => id < 0 ? residents().find((r) => r.entry.generation === id) : void 0;
  const residentOf = residentLookup(residentById);
  const entryById = (id) => plan.modules.find((candidate) => candidate.generation === id) ?? residentById(id)?.entry;
  const findEntry = (path, withinPlan = false) => {
    if (withinPlan) {
      const bare = !path.includes("/");
      return uniquePlanEntry(path) ?? residents().find((r) => r.entry.path === path || bare && r.entry.path.endsWith(`/${path}`))?.entry;
    }
    for (const candidate of searchCandidates(path)) {
      const found = plan.modules.find((m) => m.path === candidate) ?? residents().find((r) => r.entry.path === candidate)?.entry;
      if (found) return found;
    }
    return plan.modules.find((m) => m.path.endsWith(`/${path}`)) ?? (path.includes("/") ? void 0 : residents().find((r) => r.entry.path.endsWith(`/${path}`))?.entry);
  };
  const uniquePlanEntry = (path) => {
    const matching = plan.modules.filter((candidate) => candidate.path === path || candidate.path.endsWith(`/${path}`));
    return matching.length === 1 ? matching[0] : void 0;
  };
  const readString = (ptr, len) => {
    const view = new Uint8Array(memory.buffer);
    if (ptr < 0 || len < 0 || ptr + len > view.byteLength) return null;
    return new TextDecoder().decode(view.subarray(ptr, ptr + len));
  };
  const visibleDependencyIds = (entry, out = /* @__PURE__ */ new Set(), includeImplicit = false) => {
    const queue = [
      entry
    ];
    for (let index = 0; index < queue.length; index++) {
      for (const dependencyPath of [
        ...queue[index].needed,
        ...includeImplicit ? queue[index].implicitProviders ?? [] : []
      ]) {
        const dependency = findEntry(dependencyPath, true);
        if (!dependency || out.has(dependency.generation)) continue;
        out.add(dependency.generation);
        queue.push(dependency);
      }
    }
    return out;
  };
  const lookupScopeIds = (entry) => {
    const out = /* @__PURE__ */ new Set([
      entry.generation
    ]);
    const queue = [
      entry
    ];
    for (let index = 0; index < queue.length; index++) {
      for (const dependencyPath of queue[index].needed) {
        const dependency = findEntry(dependencyPath);
        if (!dependency || out.has(dependency.generation)) continue;
        out.add(dependency.generation);
        queue.push(dependency);
      }
    }
    return out;
  };
  const syncDefaultChain = () => {
    const live = /* @__PURE__ */ new Set();
    for (const candidate of plan.modules) {
      if (!candidate.global || closedGenerations.has(candidate.generation)) {
        continue;
      }
      for (const id of lookupScopeIds(candidate)) {
        if (!closedGenerations.has(id)) live.add(id);
      }
    }
    for (let index = defaultChain.length - 1; index >= 0; index--) {
      if (!live.has(defaultChain[index])) defaultChain.splice(index, 1);
    }
    for (const id of live) {
      if (!defaultChain.includes(id)) defaultChain.push(id);
    }
    return defaultChain;
  };
  const dependencyRetirementOrder = (entry) => {
    const ids = [
      ...visibleDependencyIds(entry, /* @__PURE__ */ new Set(), true)
    ];
    const idSet = new Set(ids);
    const incoming = new Map(ids.map((id) => [
      id,
      0
    ]));
    for (const ownerId of ids) {
      const owner = plan.modules.find((candidate) => candidate.generation === ownerId);
      if (!owner) continue;
      for (const dependencyPath of [
        ...owner.needed,
        ...owner.implicitProviders ?? []
      ]) {
        const dependency = findEntry(dependencyPath, true);
        if (!dependency || !idSet.has(dependency.generation)) continue;
        incoming.set(dependency.generation, (incoming.get(dependency.generation) ?? 0) + 1);
      }
    }
    const ready = ids.filter((id) => incoming.get(id) === 0);
    const ordered = [];
    for (let index = 0; index < ready.length; index++) {
      const id = ready[index];
      ordered.push(id);
      const owner = plan.modules.find((candidate) => candidate.generation === id);
      if (!owner) continue;
      for (const dependencyPath of [
        ...owner.needed,
        ...owner.implicitProviders ?? []
      ]) {
        const dependency = findEntry(dependencyPath, true);
        if (!dependency || !idSet.has(dependency.generation)) continue;
        const remaining = (incoming.get(dependency.generation) ?? 0) - 1;
        incoming.set(dependency.generation, remaining);
        if (remaining === 0) ready.push(dependency.generation);
      }
    }
    return ordered;
  };
  const providerScopeIds = (owner) => {
    const ids = /* @__PURE__ */ new Set();
    for (const resident of residents()) {
      materialize(resident.entry.generation);
      ids.add(resident.entry.generation);
    }
    for (const id of visibleDependencyIds(owner)) ids.add(id);
    for (const candidate of plan.modules) {
      if (candidate.global) ids.add(candidate.generation);
    }
    return ids;
  };
  const symbolValue = (name, owner, providers) => {
    const main = getMainExport?.(name);
    if (main !== void 0) return main;
    for (const id of providerScopeIds(owner)) {
      const value = materialized.get(id)?.get(name);
      if (value !== void 0) {
        providers?.add(id);
        return value;
      }
    }
    return void 0;
  };
  const mainSymbolAddress = (name) => {
    const main = getMainExport?.(name);
    if (main instanceof WebAssembly.Global) return Number(main.value);
    if (typeof main !== "function") return void 0;
    const cached = mainFunctionSymbols.get(name);
    if (cached !== void 0) return cached;
    const table = getWasmTable?.();
    if (!table) return void 0;
    const index = existingFunctionTableSlot(table, main) ?? reserveMainFunctionSlot?.(name, table.length) ?? table.length;
    if (table.length <= index) table.grow(index + 1 - table.length);
    table.set(index, main);
    mainFunctionSymbols.set(name, index);
    return index;
  };
  const moduleSymbolAddress = (entry, name) => {
    const value = materialized.get(entry.generation)?.get(name);
    if (value instanceof WebAssembly.Global) return Number(value.value) >>> 0;
    return functionSlots.get(entry.generation)?.get(name);
  };
  const existingDsoFunctionSlot = (name, value) => {
    if (getMainExport?.(name) === value) return void 0;
    for (const [id, symbols] of materialized) {
      for (const [symbol, candidate] of symbols) {
        if (candidate !== value) continue;
        const slot = functionSlots.get(id)?.get(symbol);
        if (slot !== void 0) return slot;
      }
    }
    return void 0;
  };
  const sideFunctionAddress = (name, owner) => {
    let address = mainSymbolAddress(name);
    if (address === void 0) {
      for (const id of providerScopeIds(owner)) {
        const entry = entryById(id);
        if (entry) address = moduleSymbolAddress(entry, name);
        if (address !== void 0) break;
      }
    }
    return address;
  };
  const guestOpen = (entry) => entry.opens > 0;
  const forgetOpenState = (generation) => {
    const run = runSlots.get(generation);
    if (run) {
      const table = getWasmTable?.();
      if (table) {
        for (let i = 0; i < run.len; i++) table.set(run.base + i, null);
      }
      runSlots.delete(generation);
    }
    pendingRuns.delete(generation);
    handles.delete(generation);
    refCounts.delete(generation);
    ownedFetchedDependencies.delete(generation);
  };
  const runCleanups = (...cleanups) => {
    let threw = false;
    let first;
    let terminal;
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        if (!threw) first = error;
        threw = true;
        if (terminal === void 0 && isGuestTerminal(error)) terminal = error;
      }
    }
    return {
      threw,
      error: terminal ?? first
    };
  };
  const afterCleanups = (original, cleaned) => isGuestTerminal(original) || !cleaned.threw ? original : cleaned.error;
  const uploadModuleBytes = (transport, bytes) => {
    const id = transport.uploadBegin(bytes.byteLength);
    if (id < 0) return id;
    try {
      for (let offset = 0; offset < bytes.byteLength; ) {
        const end = Math.min(offset + MODULE_BYTES_CHUNK, bytes.byteLength);
        const rc = transport.uploadChunk(id, offset, bytes.subarray(offset, end));
        if (rc < 0) {
          transport.uploadAbort(id);
          return rc;
        }
        offset = end;
      }
    } catch (error) {
      throw afterCleanups(error, runCleanups(() => transport.uploadAbort(id)));
    }
    return id;
  };
  const refreshPlan = (allowStale = false) => {
    const refreshed = refreshRuntimeLinkPlan?.();
    if (refreshed === null || typeof refreshed === "number") {
      if (allowStale) return plan;
      throw new RuntimeLinkRefreshFailed(refreshed);
    }
    if (!refreshed) return plan;
    syncDefaultChain();
    for (const incoming of refreshed.modules) {
      if (incoming.opens > 0) closedGenerations.delete(incoming.generation);
      const existing = plan.modules.find((candidate) => candidate.generation === incoming.generation || candidate.path === incoming.path);
      if (existing && existing.generation !== incoming.generation) {
        forgetOpenState(existing.generation);
        closedGenerations.delete(existing.generation);
        removeLocalGeneration(existing, false);
      }
      const current = existing && existing.generation === incoming.generation ? existing : void 0;
      if (current) {
        if (incoming.bytes.byteLength > 0) {
          compiledModules.delete(current.generation);
          compiledModules.delete(incoming.generation);
        }
        Object.assign(current, incoming, {
          bytes: incoming.bytes.byteLength > 0 ? incoming.bytes.slice() : current.bytes
        });
      } else {
        plan.modules.push({
          ...incoming,
          bytes: incoming.bytes.slice()
        });
      }
      if (incoming.opens <= 0) forgetOpenState(incoming.generation);
    }
    for (const local of [
      ...plan.modules
    ]) {
      const live = refreshed.modules.some((incoming) => incoming.generation === local.generation);
      if (live) continue;
      local.opens = 0;
      if (fetchedGenerations.has(local.generation) && !locallyPublished.has(local.generation)) continue;
      forgetOpenState(local.generation);
      closedGenerations.delete(local.generation);
      removeLocalGeneration(local, false);
    }
    return refreshed;
  };
  const REPORTED = {
    reported: true
  };
  const publishBytes = (path, bytes, file) => {
    try {
      validateNoLegacyGrowthImports(bytes);
      validateNoDirectMemoryGrow(bytes);
      validateNoRuntimeMutableGlobals(bytes);
      const fetchedModule = new WebAssembly.Module(bytes);
      assertReplayNamespaceAvailable(fetchedModule);
      const dylink = readStartupDylink(fetchedModule);
      if (!dylink) {
        errors.value = `dlopen: ${path}: not a side module`;
        return REPORTED;
      }
      const { memSize, memAlign, tableSize, needed } = dylink;
      const transformed = transformReplayModule(bytes);
      const replayBytes = transformed.bytes;
      const module = transformed.deferredStartExport === void 0 ? fetchedModule : new WebAssembly.Module(replayBytes);
      const functionCount = dsoFunctionExports(module).length;
      const table = getWasmTable?.();
      const tableReservation = tableSize + functionCount;
      const fallbackGeneration = plan.modules.reduce((max, candidate) => Math.max(max, candidate.generation), 0) + 1;
      const reservedLayout = reserveRuntimeLinkLayout?.(path, tableReservation, table?.length ?? 0);
      if (reserveRuntimeLinkLayout && !reservedLayout) {
        errors.value = `dlopen: ${path}: coordinator reservation busy`;
        return REPORTED;
      }
      const layout = reservedLayout ?? {
        generation: fallbackGeneration,
        tableBase: table?.length ?? 0,
        existing: false
      };
      if (layout.existing) {
        refreshPlan();
        const existing = findEntry(path);
        return existing ? {
          entry: existing
        } : {
          reported: false
        };
      }
      const { generation, tableBase } = layout;
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        errors.value = `dlopen: ${path}: coordinator reservation failed`;
        return REPORTED;
      }
      if (table && table.length < tableBase + tableReservation) {
        table.grow(tableBase + tableReservation - table.length);
      }
      let memoryBase = 0;
      let allocationBase = 0;
      if (memSize > 0) {
        const alloc = getMainExport?.("__alloc");
        if (typeof alloc !== "function") {
          abortRuntimeLinkLayout?.(path);
          errors.value = `dlopen: ${path}: __alloc export not available`;
          return REPORTED;
        }
        const align = Math.max(1, 1 << Math.min(30, memAlign));
        const raw = Number(runImageSetupGuest(() => alloc(memSize + align - 1)));
        if (!Number.isFinite(raw) || raw <= 0) {
          abortRuntimeLinkLayout?.(path);
          errors.value = `dlopen: ${path}: __alloc failed`;
          return REPORTED;
        }
        allocationBase = raw;
        memoryBase = Math.ceil(raw / align) * align;
        zeroFreshDsoMemory(memory, memoryBase, memSize);
      }
      const entry = {
        path,
        ...file !== void 0 && {
          file
        },
        bytes: replayBytes,
        generation,
        memoryBase,
        memorySize: memSize,
        allocationBase,
        tableBase,
        tableSize,
        needed,
        refCount: 1,
        opens: 0,
        global: false,
        nodelete: false
      };
      plan.modules.push(entry);
      fetchedGenerations.add(entry.generation);
      compiledModules.set(entry.generation, module);
      return {
        entry
      };
    } catch (error) {
      if (isGuestTerminal(error)) throw error;
      if (error instanceof RuntimeLinkRefreshFailed) {
        errors.value = `${error.message} (E2BIG or not ready)`;
        refreshFailedDuringLoad = true;
        return REPORTED;
      }
      errors.value = `dlopen: ${path}: invalid wasm (${error})`;
      return REPORTED;
    }
  };
  let refreshFailedDuringLoad = false;
  let searchExplainedFailure = false;
  let parentContextFinalized = false;
  const attributeDependencyFailure = (edge, parent, name, found) => {
    if (!refreshFailedDuringLoad) {
      if (errors.value === null || !found) {
        errors.value = `dlopen: ${parent}: missing dependency '${name}'`;
      } else if (edge === "needed" && !parentContextFinalized) {
        errors.value = `${errors.value} (needed by ${parent})`;
      }
    }
    parentContextFinalized = true;
  };
  const openCandidate = (candidate) => {
    const provided = providedModuleBytes.get(candidate);
    if (provided) {
      return {
        kind: "opened",
        path: candidate,
        bytes: provided.bytes.slice(),
        ...provided.file !== void 0 && {
          file: provided.file
        }
      };
    }
    if (!fetchRuntimeModule) return {
      kind: "error",
      errno: ENOENT
    };
    return fetchRuntimeModule(candidate, 0);
  };
  const searchAndPublish = (path) => {
    refreshFailedDuringLoad = false;
    searchExplainedFailure = false;
    let published = {
      reported: false
    };
    const accept = (candidate, bytes, file) => {
      const loaded = file === void 0 ? void 0 : plan.modules.find((candidate2) => candidate2.file === file) ?? residents().find((resident) => resident.entry.file === file)?.entry;
      published = loaded ? {
        entry: loaded
      } : publishBytes(candidate, bytes, file);
      return "entry" in published ? {
        ok: true
      } : {
        ok: false,
        errno: ENOEXEC
      };
    };
    const outcome = providedModuleBytes.has(path) ? searchPaths([
      path
    ], openCandidate, accept) : searchLibrary(path, librarySearch.policy, cwdCache.get, openCandidate, accept);
    if (outcome.kind === "found") {
      return "entry" in published ? published.entry : void 0;
    }
    searchExplainedFailure = outcome.kind !== "absent";
    if (!("reported" in published && published.reported)) {
      errors.value = outcome.kind === "stop" ? `dlopen: ${path}: cannot open ${outcome.path} (errno ${outcome.errno})` : outcome.kind === "halt" ? `dlopen: ${path}: search halted at ${outcome.path}` : `dlopen: ${path}: cannot open shared object file (errno ${outcome.errno})`;
    }
    return void 0;
  };
  const publishResolvedDependency = (path) => {
    refreshFailedDuringLoad = false;
    searchExplainedFailure = false;
    parentContextFinalized = false;
    const existing = findEntry(path, true) ?? (replayingPlan ? void 0 : findEntry(path));
    if (existing || replayingPlan) return existing;
    return searchAndPublish(path);
  };
  const materialize = (id, newlyMaterialized = []) => {
    const existing = instances.get(id);
    if (existing) return existing;
    const resident = residentById(id);
    if (resident) {
      instances.set(id, resident.instance);
      materialized.set(id, resident.symbols);
      functionSlots.set(id, resident.slots);
      return resident.instance;
    }
    const entry = plan.modules.find((candidate) => candidate.generation === id);
    if (!entry) return void 0;
    if (materializing.has(id)) {
      errors.value = `dlopen: ${entry.path}: circular dylink dependency`;
      return void 0;
    }
    materializing.add(id);
    try {
      bytesOf(entry);
    } catch (error) {
      materializing.delete(id);
      if (isGuestTerminal(error)) throw error;
      errors.value = `dlopen: ${entry.path}: ${error}`;
      if (error instanceof ModuleBytesGone) bytesGone = true;
      return void 0;
    }
    const fresh = fetchedGenerations.has(id);
    const edges = [
      [
        "needed",
        entry.needed
      ],
      [
        "provider",
        entry.implicitProviders ?? []
      ]
    ];
    for (const [edge, names] of edges) {
      for (let i = 0; i < names.length; i++) {
        const dependency = publishResolvedDependency(names[i]);
        if (!dependency || !materialize(dependency.generation, newlyMaterialized)) {
          attributeDependencyFailure(edge, entry.path, names[i], dependency !== void 0 || searchExplainedFailure);
          materializing.delete(id);
          return void 0;
        }
        if (fresh) names[i] = dependency.path;
      }
    }
    for (const candidate of plan.modules) {
      if (candidate.global && candidate.generation !== id && !materializing.has(candidate.generation) && !materialized.has(candidate.generation) && !materialize(candidate.generation, newlyMaterialized)) {
        attributeDependencyFailure("provider", entry.path, candidate.path, true);
        materializing.delete(id);
        return void 0;
      }
    }
    validateNoRuntimeMutableGlobals(bytesOf(entry));
    const module = moduleOf(entry);
    const table = getWasmTable?.();
    const functionExports = dsoFunctionExports(module);
    const requiredTableLength = entry.tableBase + entry.tableSize + functionExports.length;
    if (table && table.length < requiredTableLength) {
      table.grow(requiredTableLength - table.length);
    }
    const boundProviders = /* @__PURE__ */ new Set();
    const replaying = fetchedGenerations.has(id) && !initializedGenerations.has(id);
    let bound;
    try {
      bound = bindDso({
        bytes: bytesOf(entry),
        module,
        memory,
        table,
        memoryBase: entry.memoryBase,
        tableBase: entry.tableBase,
        tableSize: entry.tableSize,
        symbol: (name) => symbolValue(name, entry, boundProviders),
        functionAddress: (name) => sideFunctionAddress(name, entry),
        existingFunctionSlot: existingDsoFunctionSlot,
        initializerMode: replaying ? "replay" : "shared"
      });
    } catch (error) {
      if (isGuestTerminal(error)) throw error;
      if (table) {
        for (let i = entry.tableBase; i < requiredTableLength; i++) {
          table.set(i, null);
        }
      }
      errors.value = `dlopen: ${entry.path}: instantiate failed (${error})`;
      materializing.delete(id);
      return void 0;
    }
    const neededIds = visibleDependencyIds(entry);
    entry.implicitProviders = plan.modules.filter((candidate) => boundProviders.has(candidate.generation) && !neededIds.has(candidate.generation)).map((candidate) => candidate.path);
    const { instance } = bound;
    try {
      asyncifyParticipants.register({
        kind: "runtime",
        generation: id,
        path: entry.path
      }, instance);
    } catch (error) {
      if (table) {
        for (let i = entry.tableBase; i < requiredTableLength; i++) {
          table.set(i, null);
        }
      }
      errors.value = `dlopen: ${entry.path}: ${error}`;
      materializing.delete(id);
      return void 0;
    }
    const symbols = /* @__PURE__ */ new Map();
    const slots = /* @__PURE__ */ new Map();
    for (const [name, symbol] of bound.symbols) {
      symbols.set(name, symbol.value);
      if (typeof symbol.value === "function" && symbol.dlsym !== void 0) {
        slots.set(name, symbol.dlsym);
      }
    }
    instances.set(id, instance);
    materialized.set(id, symbols);
    functionSlots.set(id, slots);
    if (replaying && bound.initializers.length + bound.constructors.length > 0) {
      runCollector.push({
        member: id,
        initializers: [
          ...bound.initializers
        ],
        constructors: [
          ...bound.constructors
        ]
      });
    }
    if (fetchedGenerations.has(id)) initializedGenerations.add(id);
    newlyMaterialized.push(id);
    materializing.delete(id);
    return instance;
  };
  const clearLocalTableEntries = (entry) => {
    const table = getWasmTable?.();
    if (!table || !instances.has(entry.generation)) return;
    const exportedRange = (candidate) => {
      const start2 = candidate.tableBase + candidate.tableSize;
      return [
        start2,
        start2 + dsoFunctionExports(moduleOf(candidate)).length
      ];
    };
    const answered = /* @__PURE__ */ new Set();
    const owned = [];
    for (const [generation, slots] of functionSlots) {
      if (generation === entry.generation) continue;
      for (const slot of slots.values()) answered.add(slot);
      const other = plan.modules.find((candidate) => candidate.generation === generation);
      if (other && instances.has(generation)) owned.push(exportedRange(other));
    }
    const [start, end] = exportedRange(entry);
    const borrowed = [
      ...functionSlots.get(entry.generation)?.values() ?? []
    ].filter((slot) => (slot < start || slot >= end) && !owned.some(([from, to]) => slot >= from && slot < to));
    for (let slot = start; slot < end; slot++) {
      if (!answered.has(slot)) table.set(slot, null);
    }
    for (const slot of borrowed) {
      if (!answered.has(slot)) table.set(slot, null);
    }
  };
  const removeLocalGeneration = (entry, preserveNodelete = true) => {
    if (preserveNodelete && entry.nodelete) return;
    clearLocalTableEntries(entry);
    forgetInstance(entry.generation);
    initializedGenerations.delete(entry.generation);
    fetchedGenerations.delete(entry.generation);
    locallyPublished.delete(entry.generation);
    materialized.delete(entry.generation);
    functionSlots.delete(entry.generation);
    compiledModules.delete(entry.generation);
    const entryIndex = plan.modules.indexOf(entry);
    if (entryIndex >= 0) plan.modules.splice(entryIndex, 1);
  };
  const releaseGenerationMemory = (entry) => {
    if (entry.memorySize <= 0) return;
    const dealloc = getMainExport?.("__dealloc");
    if (typeof dealloc === "function") {
      runImageSetupGuest(() => dealloc(entry.allocationBase ?? entry.memoryBase, entry.memorySize));
    }
  };
  const abortPendingLoads = () => {
    const pending = [
      ...fetchedGenerations
    ].filter((generation) => !locallyPublished.has(generation));
    for (const generation of pending.toReversed()) {
      const entry = plan.modules.find((candidate) => candidate.generation === generation);
      if (!entry) {
        fetchedGenerations.delete(generation);
        continue;
      }
      abortRuntimeLinkLayout?.(entry.path);
      releaseGenerationMemory(entry);
      removeLocalGeneration(entry, false);
    }
  };
  let replayingPlan = false;
  const materializeRuntimeLinks = () => {
    replayingPlan = true;
    try {
      return replayRuntimeLinks();
    } finally {
      replayingPlan = false;
    }
  };
  const replayRuntimeLinks = () => {
    for (const entry of [
      ...plan.modules
    ].sort((a, b) => a.generation - b.generation)) {
      if (!materialize(entry.generation)) return -1;
      const instance = instances.get(entry.generation);
      if (instance && guestOpen(entry)) {
        handles.set(entry.generation, instance);
        if (!refCounts.has(entry.generation)) {
          refCounts.set(entry.generation, 1);
        }
      }
    }
    for (const entry of plan.modules) {
      if (!entry.run || !guestOpen(entry)) continue;
      if (typeof bindRuntimeRun(entry.generation, entry.run) === "number") {
        return -1;
      }
    }
    return 0;
  };
  const failPublication = (newlyMaterialized, rollbackEntry) => {
    let selected = {
      threw: false
    };
    const settle = (...steps) => {
      const cleaned = runCleanups(...steps);
      if (cleaned.threw && (!selected.threw || isGuestTerminal(cleaned.error) && !isGuestTerminal(selected.error))) selected = cleaned;
    };
    settle(() => rollbackEntry?.());
    const unpublishedFetched = [
      ...fetchedGenerations
    ].filter((generation) => !locallyPublished.has(generation));
    const rollbackGenerations = /* @__PURE__ */ new Set([
      ...newlyMaterialized,
      ...unpublishedFetched
    ]);
    for (const generation of [
      ...rollbackGenerations
    ].toReversed()) {
      const materializedEntry = plan.modules.find((candidate) => candidate.generation === generation);
      if (!unpublishedFetched.includes(generation)) {
        if (materializedEntry && newlyMaterialized.includes(generation) && !handles.has(generation)) {
          settle(() => clearLocalTableEntries(materializedEntry), () => forgetInstance(generation), () => materialized.delete(generation), () => functionSlots.delete(generation));
        }
        continue;
      }
      if (materializedEntry) {
        settle(
          () => abortRuntimeLinkLayout?.(materializedEntry.path),
          () => releaseGenerationMemory(materializedEntry),
          // live.
          () => removeLocalGeneration(materializedEntry)
        );
      }
    }
    errors.value = "dlopen: coordinator publication failed";
    if (selected.threw) throw selected.error;
    return 0;
  };
  const installRuntimeRun = (id, parts) => {
    const table = getWasmTable?.();
    if (!table) {
      errors.value = "dlopen: function table not available";
      return void 0;
    }
    const fns = runInCallOrder(parts, id, markerOf);
    let written;
    try {
      const identity = `@kh-run/${moduleIdentityPrefix}/${nextRunId++}`;
      let base = table.length;
      if (reserveRuntimeLinkLayout) {
        const layout = reserveRuntimeLinkLayout(identity, fns.length, table.length);
        if (!layout) {
          errors.value = "dlopen: initializer run reservation busy";
          return void 0;
        }
        base = layout.tableBase;
        abortRuntimeLinkLayout?.(identity);
      }
      if (table.length < base + fns.length) {
        table.grow(base + fns.length - table.length);
      }
      written = {
        base,
        len: fns.length
      };
      fns.forEach((fn, i) => table.set(base + i, fn));
      runSlots.set(id, written);
      pendingRuns.set(id, {
        base,
        len: fns.length,
        recipe: parts.map((part) => part.member)
      });
      return written;
    } catch (error) {
      if (isGuestTerminal(error)) throw error;
      if (written) clearRunRange(written);
      errors.value = `dlopen: initializer run unavailable (${error})`;
      return void 0;
    }
  };
  const clearRunRange = (range) => {
    const table = getWasmTable?.();
    if (!table) return;
    for (let i = 0; i < range.len; i++) {
      try {
        table.set(range.base + i, null);
      } catch {
      }
    }
  };
  const undoRuntimeRun = (id, range) => {
    clearRunRange(range);
    runSlots.delete(id);
    pendingRuns.delete(id);
  };
  const commitPromotion = (records) => {
    if (!mutateRuntimeLinkRecords) return refreshRuntimeLinkPlan ? -EIO : 0;
    const result = mutateRuntimeLinkRecords(records, "promote");
    if (result === false) return -EAGAIN;
    return batchRefusedFinally(result) ? -EIO : 0;
  };
  const promoteRuntimeLink = (hostId, flags) => {
    const currentPlan = refreshPlan();
    const entry = currentPlan.modules.find((candidate) => candidate.generation === hostId);
    if (!entry || !guestOpen(entry) || closedGenerations.has(hostId)) {
      return -2;
    }
    const promoted = {
      ...entry,
      // Flags only: a promote opens and closes nothing.
      opens: 0,
      global: entry.global || (flags & 256) !== 0,
      nodelete: entry.nodelete || (flags & 4096) !== 0
    };
    const committed = commitPromotion([
      promoted
    ]);
    if (committed !== 0) return committed;
    entry.global = promoted.global;
    entry.nodelete = promoted.nodelete;
    return 0;
  };
  const openRuntimeLinkPath = (path, flags) => {
    return cwdCache.run(() => {
      for (let attempt = 0; ; attempt++) {
        bytesGone = false;
        const collected = [];
        runCollector = collected;
        let result;
        try {
          result = openRuntimeLinkPathCollecting(path, flags);
        } finally {
          runCollector = void 0;
        }
        if (result > 0 || !bytesGone || attempt > 0) return result;
        refreshPlan();
      }
    });
  };
  const openRuntimeLinkPathCollecting = (path, flags) => {
    refreshPlan();
    const requestedGlobal = (flags & 256) !== 0;
    let entry;
    if (path !== null) {
      entry = findEntry(path);
      if (entry && entry.generation < 0) {
        return residentHandle(entry.generation);
      }
      if ((flags & 4) !== 0 && (!entry || !instances.has(entry.generation))) {
        errors.value = `dlopen: ${path}: object is not loaded`;
        return 0;
      }
      if (!entry) {
        entry = searchAndPublish(path);
        if (entry && entry.generation < 0) {
          return residentHandle(entry.generation);
        }
      }
    }
    const previousEntryState = entry ? {
      global: entry.global,
      nodelete: entry.nodelete,
      implicitProviders: entry.implicitProviders,
      closed: closedGenerations.has(entry.generation)
    } : void 0;
    const rollbackEntry = () => {
      if (!entry || !previousEntryState) return;
      entry.global = previousEntryState.global;
      entry.nodelete = previousEntryState.nodelete;
      entry.implicitProviders = previousEntryState.implicitProviders;
      if (previousEntryState.closed) closedGenerations.add(entry.generation);
      else closedGenerations.delete(entry.generation);
    };
    if (entry && requestedGlobal) entry.global = true;
    if (entry && (flags & 4096) !== 0) entry.nodelete = true;
    const openingNewHandle = entry !== void 0 && !handles.has(entry.generation) && !ownedFetchedDependencies.has(entry.generation);
    if (entry) {
      closedGenerations.delete(entry.generation);
    }
    const newlyMaterialized = [];
    if (!entry || !materialize(entry.generation, newlyMaterialized)) {
      const materializationError = errors.value;
      const result = failPublication(entry && fetchedGenerations.has(entry.generation) ? [
        ...newlyMaterialized,
        entry.generation
      ] : newlyMaterialized, rollbackEntry);
      errors.value = materializationError;
      return result;
    }
    const instance = instances.get(entry.generation);
    if (!instance) {
      rollbackEntry();
      return 0;
    }
    let installedRun;
    if (runCollector !== void 0 && runCollector.length > 0) {
      installedRun = installRuntimeRun(entry.generation, runCollector);
      if (!installedRun) {
        const installError = errors.value;
        const result = failPublication(newlyMaterialized, rollbackEntry);
        errors.value = installError;
        return result;
      }
    }
    const failOpenPublication = () => {
      if (installedRun) undoRuntimeRun(entry.generation, installedRun);
      return failPublication(newlyMaterialized, rollbackEntry);
    };
    const pendingMutations = [];
    let ownedDependencies = [];
    for (const generation of newlyMaterialized) {
      if (generation === entry.generation) continue;
      const dependency = plan.modules.find((candidate) => candidate.generation === generation);
      if (dependency && fetchedGenerations.has(generation) && !locallyPublished.has(generation)) {
        if (mutateRuntimeLinkRecords) {
          pendingMutations.push({
            ...dependency,
            opens: 0,
            fresh: true
          });
        } else locallyPublished.add(generation);
      }
    }
    if (openingNewHandle) {
      ownedDependencies = dependencyRetirementOrder(entry);
      for (const generation of ownedDependencies) {
        const dependency = plan.modules.find((candidate) => candidate.generation === generation);
        if (dependency && mutateRuntimeLinkRecords) {
          pendingMutations.push({
            ...dependency,
            opens: 0
          });
        }
      }
    }
    if (fetchedGenerations.has(entry.generation) && !locallyPublished.has(entry.generation)) {
      if (mutateRuntimeLinkRecords) {
        pendingMutations.push({
          ...entry,
          opens: 1,
          fresh: true
        });
      } else locallyPublished.add(entry.generation);
    } else if (mutateRuntimeLinkRecords) {
      pendingMutations.push({
        ...entry,
        opens: 1
      });
    }
    if (mutateRuntimeLinkRecords && pendingMutations.length > 0) {
      const uniqueMutations = [];
      for (const candidate of pendingMutations) {
        const seen = uniqueMutations.findIndex((record) => record.generation === candidate.generation);
        if (seen < 0) uniqueMutations.push(candidate);
        else {
          const kept = uniqueMutations[seen];
          uniqueMutations[seen] = {
            ...candidate.opens > kept.opens ? candidate : kept,
            ...(candidate.fresh || kept.fresh) && {
              fresh: true
            }
          };
        }
      }
      const owed = new Set((runCollector ?? []).map((part) => part.member));
      for (let i = 0; i < uniqueMutations.length; i++) {
        const record = uniqueMutations[i];
        if (!record.fresh) continue;
        uniqueMutations[i] = {
          ...record,
          closure: [
            ...visibleDependencyIds(record, /* @__PURE__ */ new Set(), true)
          ],
          ...owed.has(record.generation) && {
            owedBy: entry.generation
          }
        };
      }
      const uploads = [];
      const abortUploads = () => {
        const cleaned = runCleanups(...uploads.map((id) => () => bytesTransport?.uploadAbort(id)));
        if (cleaned.threw) throw cleaned.error;
      };
      let refused = false;
      try {
        if (bytesTransport) {
          for (let i = 0; i < uniqueMutations.length; i++) {
            const record = uniqueMutations[i];
            if (!record.fresh) continue;
            const id = uploadModuleBytes(bytesTransport, bytesOf(record));
            if (id < 0) {
              errors.value = `dlopen: ${record.path}: uploading the module failed (${id})`;
              refused = true;
              break;
            }
            uploads.push(id);
            uniqueMutations[i] = {
              ...record,
              uploadId: id
            };
          }
        }
        if (!refused && batchRefused(mutateRuntimeLinkRecords(uniqueMutations, "publish"))) refused = true;
      } catch (error) {
        throw afterCleanups(error, runCleanups(abortUploads, () => void failOpenPublication()));
      }
      if (refused) {
        let failed;
        const cleaned = runCleanups(abortUploads, () => {
          failed = failOpenPublication();
        });
        if (cleaned.threw) throw cleaned.error;
        return failed;
      }
      for (const mutation of uniqueMutations) {
        if (fetchedGenerations.has(mutation.generation)) {
          locallyPublished.add(mutation.generation);
        }
      }
    }
    if (ownedDependencies.length > 0) {
      ownedFetchedDependencies.set(entry.generation, ownedDependencies);
    }
    closedGenerations.delete(entry.generation);
    handles.set(entry.generation, instance);
    refCounts.set(entry.generation, (refCounts.get(entry.generation) ?? 0) + 1);
    entry.opens += 1;
    return entry.generation;
  };
  const openRuntimeLink = (pathPtr, pathLen, flags) => openRuntimeLinkPath(readString(pathPtr, pathLen), flags);
  const resolveRuntimeLinkSymbolName = (handle, name) => {
    refreshPlan();
    if (name === null) {
      errors.value = "dlsym: invalid symbol name";
      return -1;
    }
    if (ASYNCIFY_EXPORTS.some((exportName) => exportName === name)) {
      errors.value = `dlsym: symbol '${name}' not found`;
      return -1;
    }
    if (handle === 0) {
      if (isPrivateDlsymExport(name)) {
        errors.value = `dlsym: symbol '${name}' not found`;
        return -1;
      }
      const main = getMainExport?.(name);
      if (main !== void 0) {
        let address;
        if (main instanceof WebAssembly.Global) {
          address = mainGlobalDlsymValue(main);
        } else if (typeof main !== "function") {
          address = null;
        } else {
          try {
            address = mainSymbolAddress(name) ?? -ENOMEM;
          } catch (e) {
            if (!(e instanceof RangeError)) throw e;
            address = -ENOMEM;
          }
        }
        if (address === null) {
          errors.value = `dlsym: symbol '${name}' not found`;
          return -1;
        }
        if (address === -ENOMEM) {
          errors.value = `dlsym: no table slot for '${name}'`;
        }
        return address;
      }
    }
    const resident = residentOf(handle);
    if (handle !== 0 && !resident && (!plan.modules.some((entry) => entry.generation === handle && guestOpen(entry)) || closedGenerations.has(handle) || !handles.has(handle) && !materialize(handle))) {
      errors.value = `dlsym: symbol '${name ?? "<invalid>"}' not found`;
      return -1;
    }
    let ids = /* @__PURE__ */ new Set();
    if (handle !== 0) {
      const owner = resident?.entry ?? entryById(handle);
      ids = owner ? lookupScopeIds(owner) : /* @__PURE__ */ new Set([
        handle
      ]);
    } else {
      for (const resident2 of residents()) ids.add(resident2.entry.generation);
      for (const id of syncDefaultChain()) ids.add(id);
    }
    for (const id of ids) {
      if (!instances.has(id) && !materialize(id)) continue;
      const entry = entryById(id);
      if (handle === 0 && entry) {
        const defined = materialized.get(entry.generation)?.get(name);
        if (defined instanceof WebAssembly.Global && !isDlsymAddressGlobal(defined)) continue;
      }
      const address = entry && moduleSymbolAddress(entry, name);
      if (address !== void 0) return address;
    }
    errors.value = `dlsym: symbol '${name}' not found`;
    return -1;
  };
  const resolveRuntimeLinkSymbol = (handle, namePtr, nameLen) => resolveRuntimeLinkSymbolName(handle, readString(namePtr, nameLen));
  const runCopy = (handle) => {
    const entry = plan.modules.find((candidate) => candidate.generation === handle);
    if (!entry) return void 0;
    const dependencies = [
      ...ownedFetchedDependencies.get(handle) ?? dependencyRetirementOrder(entry)
    ];
    const entries = /* @__PURE__ */ new Map();
    for (const generation of dependencies) {
      const dependency = plan.modules.find((candidate) => candidate.generation === generation);
      if (dependency) entries.set(generation, {
        ...dependency
      });
    }
    return {
      entry: {
        ...entry
      },
      dependencies,
      entries,
      refs: refCounts.get(handle)
    };
  };
  const closeRuntimeLink = (handle, allowStale = false, abort = false) => {
    if (residentOf(handle)) return 0;
    const before = abort ? runCopy(handle) : void 0;
    refreshPlan(allowStale);
    syncDefaultChain();
    const sharedEntry = plan.modules.find((candidate) => candidate.generation === handle) ?? before?.entry;
    const planEntry = (generation) => plan.modules.find((candidate) => candidate.generation === generation) ?? before?.entries.get(generation);
    if (!sharedEntry || !guestOpen(sharedEntry) || closedGenerations.has(handle)) {
      if (handles.delete(handle)) refCounts.delete(handle);
      errors.value = `dlclose: invalid handle ${handle}`;
      return -1;
    }
    const refs = refCounts.get(handle) ?? before?.refs ?? 1;
    const entry = sharedEntry;
    const reverted = abort && refs <= 1 && entry.opens <= 1;
    if (reverted) entry.nodelete = false;
    const retireRecords = (records) => {
      if (records.length === 0) return true;
      const result = mutateRuntimeLinkRecords?.(records, "retire");
      if (batchRefused(result)) return false;
      return Array.isArray(result) ? result : true;
    };
    const closedRoot = entry && {
      ...entry,
      opens: 1,
      ...reverted && {
        abort: true
      }
    };
    if (refs > 1) {
      if (closedRoot && !retireRecords([
        closedRoot
      ])) {
        errors.value = "dlclose: coordinator retirement failed";
        return -1;
      }
      refCounts.set(handle, refs - 1);
      if (entry) entry.opens = Math.max(0, entry.opens - 1);
      return 0;
    }
    const dependencies = before?.dependencies ?? ownedFetchedDependencies.get(handle) ?? (entry ? dependencyRetirementOrder(entry) : []);
    const releaseDependencies = !entry?.nodelete;
    const retirementRecords = closedRoot ? [
      closedRoot
    ] : [];
    if (releaseDependencies) {
      for (const generation of dependencies) {
        const dependency = planEntry(generation);
        if (dependency) retirementRecords.push({
          ...dependency,
          opens: 0
        });
      }
    }
    const retired = retireRecords(retirementRecords);
    if (retired === false) {
      errors.value = "dlclose: coordinator retirement failed";
      return -1;
    }
    if (entry) entry.opens = Math.max(0, entry.opens - 1);
    const refreshed = Array.isArray(retired) ? void 0 : refreshRuntimeLinkPlan?.();
    const readBack = Array.isArray(retired) ? void 0 : new Set((refreshed && typeof refreshed === "object" ? refreshed.modules : plan.modules).map((record) => record.generation));
    const stillHeld = (generation) => readBack ? readBack.has(generation) : !retired.includes(generation);
    const run = runSlots.get(handle);
    if (run) {
      const table = getWasmTable?.();
      if (table) {
        for (let i = 0; i < run.len; i++) table.set(run.base + i, null);
      }
      runSlots.delete(handle);
    }
    pendingRuns.delete(handle);
    handles.delete(handle);
    refCounts.delete(handle);
    closedGenerations.add(handle);
    if (releaseDependencies) ownedFetchedDependencies.delete(handle);
    if (releaseDependencies) {
      for (const generation of dependencies) {
        const dependency = planEntry(generation);
        if (!dependency) continue;
        const stillOwned = [
          ...ownedFetchedDependencies.values()
        ].some((owned) => owned.includes(generation));
        if (!handles.has(generation) && !stillOwned) {
          if (!stillHeld(generation)) {
            releaseGenerationMemory(dependency);
          }
          removeLocalGeneration(dependency);
        }
      }
    }
    const entryStillOwned = [
      ...ownedFetchedDependencies.values()
    ].some((owned) => owned.includes(handle));
    if (entry && !entryStillOwned) {
      if (!stillHeld(entry.generation)) {
        releaseGenerationMemory(entry);
      }
      removeLocalGeneration(entry);
    }
    return 0;
  };
  const readRuntimeLinkError = (outPtr, outCap) => {
    if (errors.value === null || outCap <= 0) return 0;
    const bytes = new TextEncoder().encode(errors.value);
    const n = Math.min(bytes.byteLength, outCap);
    const view = new Uint8Array(memory.buffer);
    if (outPtr < 0 || outPtr + n > view.byteLength) return 0;
    view.set(bytes.subarray(0, n), outPtr);
    errors.value = null;
    return n;
  };
  const jitModules = /* @__PURE__ */ new Map();
  let nextJitId = 2147483647;
  const mountPreparedJit = (bytes, module, flags = 0) => {
    if ((flags & 4) !== 0) {
      errors.value = "dlopen: RTLD_NOLOAD requires an identified object";
      return -EINVAL;
    }
    if (flags !== 0) {
      errors.value = "dlopen: JIT modules do not accept loader flags";
      return -EINVAL;
    }
    const identity = `@kh-module/${moduleIdentityPrefix}/${nextProvidedModuleId++}`;
    let reservedJitRange = false;
    try {
      const mounted = instantiateJitModule(bytes, module, memory, getWasmTable?.(), getMainExport, (length, minimum) => {
        if (!reserveRuntimeLinkLayout) return minimum;
        const layout = reserveRuntimeLinkLayout(identity, length, minimum);
        if (!layout) throw new Error("JIT table range reservation failed");
        reservedJitRange = true;
        return layout.tableBase;
      });
      if (!mounted.ok) {
        errors.value = mounted.message;
        return mounted.rc;
      }
      const id = nextJitId--;
      jitModules.set(id, mounted);
      return id;
    } catch (e) {
      if (isGuestTerminal(e)) throw e;
      errors.value = `dlopen: invalid wasm (${e})`;
      return 0;
    } finally {
      if (reservedJitRange) abortRuntimeLinkLayout?.(identity);
    }
  };
  const moduleIsJit = (bytes) => {
    try {
      return !moduleHasDylink0Section(bytes);
    } catch (e) {
      if (isGuestTerminal(e)) throw e;
      errors.value = `dlopen: invalid wasm (${e})`;
      return null;
    }
  };
  const loadModuleBytes = (bytes, flags = 0, file) => {
    if ((flags & 4) !== 0) {
      errors.value = "dlopen: RTLD_NOLOAD requires an identified object";
      return -EINVAL;
    }
    const jit = moduleIsJit(bytes);
    if (jit === null) return 0;
    if (jit) {
      try {
        return mountPreparedJit(bytes, new WebAssembly.Module(bytes), flags);
      } catch (e) {
        if (isGuestTerminal(e)) throw e;
        errors.value = `dlopen: invalid wasm (${e})`;
        return 0;
      }
    }
    const identity = `@kh-module/${moduleIdentityPrefix}/${nextProvidedModuleId++}`;
    providedModuleBytes.set(identity, {
      bytes: bytes.slice(),
      file
    });
    try {
      return openRuntimeLinkPath(identity, flags);
    } finally {
      providedModuleBytes.delete(identity);
    }
  };
  const bindRuntimeRun = (hostId, consumed) => {
    const table = getWasmTable?.();
    const known = plan.modules.some((entry) => entry.generation === hostId && guestOpen(entry)) && !closedGenerations.has(hostId);
    if (!known) return -EBADF;
    if (!table) return -EIO;
    const parts = [];
    for (const generation of consumed.recipe) {
      if (!plan.modules.some((entry) => entry.generation === generation)) {
        return -EBADF;
      }
      const instance = instances.get(generation) ?? materialize(generation);
      if (!instance) return -EIO;
      parts.push({
        member: generation,
        ...dsoInitializerFunctions(instance)
      });
    }
    const fns = runInCallOrder(parts, hostId, markerOf);
    if (fns.length !== consumed.len) return -EIO;
    try {
      if (table.length < consumed.base + fns.length) {
        table.grow(consumed.base + fns.length - table.length);
      }
      fns.forEach((fn, i) => table.set(consumed.base + i, fn));
    } catch {
      return -EIO;
    }
    runSlots.set(hostId, {
      base: consumed.base,
      len: fns.length
    });
    return {
      base: consumed.base,
      len: fns.length
    };
  };
  const RETIRE_REFUSED = "dlclose: coordinator retirement failed";
  const MAX_RETIRE_BACKOFF = 16;
  const pendingRetires = /* @__PURE__ */ new Map();
  const retryRefusedRetires = (except) => {
    for (const [handle, state] of [
      ...pendingRetires
    ]) {
      if (handle === except) continue;
      if (state.skip > 0) {
        state.skip--;
        continue;
      }
      const saved = errors.value;
      let closed;
      try {
        closed = closeRuntimeLink(handle, true);
      } catch (error) {
        if (error instanceof RuntimeLinkRefreshFailed) continue;
        throw error;
      }
      const transient = closed !== 0 && errors.value === RETIRE_REFUSED;
      errors.value = saved;
      if (transient) {
        state.refusals++;
        state.skip = Math.min(2 ** state.refusals, MAX_RETIRE_BACKOFF) - 1;
      } else pendingRetires.delete(handle);
    }
  };
  const releaseModule = (hostId, abort) => {
    const jit = jitModules.get(hostId);
    if (jit) {
      const table = getWasmTable?.();
      if (table) {
        for (let i = 0; i < jit.len; i++) table.set(jit.base + i, null);
      }
      jitModules.delete(hostId);
      return 0;
    }
    retryRefusedRetires(hostId);
    const closed = closeRuntimeLink(hostId, true, abort);
    if (closed === 0) return 0;
    if (errors.value === RETIRE_REFUSED) {
      pendingRetires.set(hostId, {
        refusals: 1,
        skip: 0
      });
    }
    return -EAGAIN;
  };
  const moduleOps = {
    loadFromBytes: loadModuleBytes,
    loadCompiledModule: (bytes, module, flags = 0) => {
      const jit = moduleIsJit(bytes);
      if (jit === null) return 0;
      return jit ? mountPreparedJit(bytes, module, flags) : loadModuleBytes(bytes, flags);
    },
    promote: (hostId, flags) => {
      if (jitModules.has(hostId)) return flags === 0 ? 0 : -EINVAL;
      if (residentOf(hostId)) return 0;
      return promoteRuntimeLink(hostId, flags);
    },
    symbol: (hostId, name) => jitModules.has(hostId) ? -1 : resolveRuntimeLinkSymbolName(hostId, name),
    error: (hostId) => {
      if (hostId !== 0) return null;
      const error = errors.value;
      errors.value = null;
      return error;
    },
    info: (hostId) => {
      const jit = jitModules.get(hostId);
      if (jit) return {
        base: jit.base,
        len: jit.len
      };
      const currentPlan = refreshPlan();
      const resident = residentOf(hostId);
      const entry = resident?.entry ?? currentPlan.modules.find((candidate) => candidate.generation === hostId);
      if (!entry || !resident && (!guestOpen(entry) || closedGenerations.has(hostId))) return null;
      let functions;
      try {
        functions = dsoFunctionExports(moduleOf(entry)).length;
      } catch (error) {
        if (isGuestTerminal(error)) throw error;
        return null;
      }
      return {
        base: entry.tableBase,
        len: entry.tableSize + functions
      };
    },
    initRun: (hostId) => {
      const recipeOwner = () => {
        for (const entry of plan.modules) {
          if (guestOpen(entry) && !closedGenerations.has(entry.generation) && entry.run?.recipe.includes(hostId)) return entry.generation;
        }
        for (const [root2, run2] of pendingRuns) {
          if (run2.recipe.includes(hostId)) return root2;
        }
        return hostId;
      };
      if (jitModules.has(hostId) || residentOf(hostId)) {
        return {
          base: 0,
          len: 0,
          owner: hostId
        };
      }
      refreshPlan();
      const known = plan.modules.some((entry) => entry.generation === hostId && guestOpen(entry)) && !closedGenerations.has(hostId);
      if (!known) return -EBADF;
      const run = pendingRuns.get(hostId);
      if (!run) return {
        base: 0,
        len: 0,
        owner: recipeOwner()
      };
      const owner = recipeOwner();
      const root = plan.modules.find((entry) => entry.generation === hostId);
      const taken = {
        base: run.base,
        len: run.len,
        recipe: [
          ...run.recipe
        ]
      };
      const published = {
        ...root,
        run: taken,
        opens: 0
      };
      const committed = commitPromotion([
        published
      ]);
      if (committed !== 0) return committed;
      root.run = taken;
      pendingRuns.delete(hostId);
      return {
        base: taken.base,
        len: taken.len,
        owner
      };
    },
    runLength: (hostId) => pendingRuns.get(hostId)?.len ?? 0,
    unload: (hostId) => releaseModule(hostId, false),
    abort: (hostId) => void releaseModule(hostId, true),
    owns: (hostId) => {
      if (jitModules.has(hostId) || residentOf(hostId)) return true;
      refreshPlan();
      return handles.has(hostId) && !closedGenerations.has(hostId);
    }
  };
  const failClosed = (operation, failure, finalFailure = failure) => (...args) => {
    try {
      return operation(...args);
    } catch (error) {
      if (!(error instanceof RuntimeLinkRefreshFailed)) throw error;
      errors.value = `${error.message} (E2BIG or not ready)`;
      return error.transient ? failure : finalFailure;
    }
  };
  const afterRetries = (operation) => (...args) => {
    retryRefusedRetires();
    return operation(...args);
  };
  moduleOps.loadFromBytes = failClosed(afterRetries(moduleOps.loadFromBytes), 0);
  moduleOps.loadCompiledModule = failClosed(afterRetries(moduleOps.loadCompiledModule), 0);
  moduleOps.promote = failClosed(moduleOps.promote, -EAGAIN, -EIO);
  moduleOps.symbol = failClosed(moduleOps.symbol, -1);
  moduleOps.info = failClosed(moduleOps.info, null);
  moduleOps.initRun = failClosed(moduleOps.initRun, -EAGAIN, -EIO);
  moduleOps.owns = failClosed(moduleOps.owns, false);
  Object.defineProperty(yurt, RUNTIME_LINK_OPS, {
    enumerable: false,
    value: {
      materialize: materializeRuntimeLinks,
      abortPendingLoads,
      open: failClosed(openRuntimeLink, 0),
      symbol: failClosed(resolveRuntimeLinkSymbol, -1),
      close: failClosed(closeRuntimeLink, -1),
      error: readRuntimeLinkError,
      moduleOps,
      pendingRetires: () => pendingRetires.size,
      defaultChainLength: () => syncDefaultChain().length,
      pendingRuns: () => [
        ...pendingRuns
      ].map(([id, run]) => ({
        id,
        base: run.base,
        len: run.len,
        recipe: [
          ...run.recipe
        ]
      })),
      adoptPendingRuns: (runs) => {
        for (const run of runs) {
          const bound = bindRuntimeRun(run.id, run);
          if (typeof bound === "number") return bound;
          pendingRuns.set(run.id, {
            base: run.base,
            len: run.len,
            recipe: [
              ...run.recipe
            ]
          });
        }
        return 0;
      },
      asyncify: asyncifyParticipants
    }
  });
}
function workerSetRlimit(mailbox, pendingWake, resource, soft, hard) {
  const request = new Uint8Array(20);
  const view = new DataView(request.buffer);
  view.setUint32(0, resource >>> 0, true);
  view.setBigUint64(4, soft, true);
  view.setBigUint64(12, hard, true);
  return Number(relayStructuredSyscall(mailbox, pendingWake, METHOD.SYS_SETRLIMIT, request, 0).rc);
}
function currentMailboxState(mailbox) {
  return mailbox.state;
}
function servicePendingModuleOperation(mailbox) {
  const channel = activeModuleOpChannel;
  const moduleOps = activeModuleOps;
  if (!channel || !moduleOps || servicingModuleOp) return false;
  if (mailbox.state !== "IDLE") return false;
  return serviceWorkerRpcRequest(channel, (request) => {
    servicingModuleOp = true;
    try {
      return dispatchWorkerModuleRpcRequest(request, moduleOps, activeInputReader);
    } finally {
      servicingModuleOp = false;
    }
  });
}
function servicePendingModuleOperationDetailed(mailbox) {
  const channel = activeModuleOpChannel;
  const moduleOps = activeModuleOps;
  if (!channel || !moduleOps) return {
    state: "idle"
  };
  if (mailbox.state !== "IDLE") return {
    state: "idle"
  };
  return serviceWorkerRpcRequestDetailed(channel, (request) => {
    servicingModuleOp = true;
    try {
      return dispatchWorkerModuleRpcRequest(request, moduleOps, activeInputReader);
    } finally {
      servicingModuleOp = false;
    }
  });
}
function parkForever(mailbox) {
  const word = mailbox.controlWord;
  for (; ; ) guestWait(mailbox.control, 0, word);
}
function beginRelay(mailbox) {
  if (mailbox.state === "TERMINATED") parkForever(mailbox);
  try {
    transitionMailbox(mailbox, "REQUESTED");
    transitionMailbox(mailbox, "RUNNING");
  } catch (err) {
    if (currentMailboxState(mailbox) === "TERMINATED") parkForever(mailbox);
    throw err;
  }
}
function waitForReply(mailbox, pendingWake) {
  while (true) {
    const word = mailbox.controlWord;
    const state = decodeState(word);
    if (state === "REPLIED") return;
    if (state === "TERMINATED") parkForever(mailbox);
    if (state === "RUNNING") {
      try {
        parkWithPendingWakeInterlock(mailbox, pendingWake);
      } catch (err) {
        const liveState = currentMailboxState(mailbox);
        if (liveState === "TERMINATED") parkForever(mailbox);
        if (liveState !== "REPLIED") throw err;
      }
      continue;
    }
    Atomics.wait(mailbox.control, 0, word, RELAY_POLL_MS);
  }
}
function throwIfProcessTerminated(rc) {
  const rcNum = Number(rc);
  const haltStatus = machineHaltedStatus(rcNum);
  if (haltStatus !== void 0) {
    throw new GuestProcessExited(haltStatus);
  }
  const signaled = processSignaledStatus(rcNum);
  if (signaled !== void 0) {
    throw new GuestProcessExited(128 + signaled.signal);
  }
  const exitStatus = processExitedStatus(rcNum);
  if (exitStatus !== void 0) {
    throw new GuestProcessExited(exitStatus);
  }
}
var WorkerRawSyscallReplay = class {
  nr;
  method;
  parkedRetries;
  constructor(nr) {
    this.nr = nr;
    this.method = METHOD.KERNEL_DO_SYSCALL;
    this.parkedRetries = 0;
  }
  accept(rc) {
    if (Number(rc) === SYSCALL_SEAL_UNWIND) return false;
    this.method = METHOD.KERNEL_CONTINUE_SYSCALL;
    if (Number(rc) === SYSCALL_REDISPATCH) return true;
    if (Number(rc) !== WAIT_PARKED) return false;
    if (++this.parkedRetries > GUEST_SYSCALL_WAIT_PARKED_RETRY_CAP) {
      throw new Error(`Worker syscall: WAIT_PARKED retried more than ${GUEST_SYSCALL_WAIT_PARKED_RETRY_CAP} times for syscall nr=${this.nr} \u2014 the kernel is not making progress`);
    }
    return true;
  }
};
var SignalPollAnswerer = class {
  mailbox;
  #acceptedPointer;
  #withheld;
  constructor(mailbox) {
    this.mailbox = mailbox;
    this.#withheld = false;
  }
  /** The call in flight was withheld for a seal before dispatch: its 0n is
   *  not the kernel's answer, so its pointer is not accepted. */
  withheld() {
    this.#withheld = true;
  }
  syscall(nr, deliveryPtr, relay) {
    if (nr !== METHOD.SYS_SIGNAL_POLL) return relay();
    if (this.mailbox.signalPending === 0 && this.#acceptedPointer === deliveryPtr) {
      return 0n;
    }
    this.#withheld = false;
    const rc = relay();
    this.#acceptedPointer = rc >= 0n && !this.#withheld ? deliveryPtr : void 0;
    return rc;
  }
};
function signalPollAnswererFor(mailbox) {
  return new SignalPollAnswerer(mailbox);
}
function guestSyscall(mailbox, pendingWake, nr, a1, a2, a3, a4, a5, a6, relay = relayStructuredSyscall, releaseThreadStackForExit = () => {
}, resolvePendingThreadStackBounds, abortReservedThreadStart, serviceModuleRedispatch = servicePendingModuleOperationDetailed, seal, afterThreadExitPrepare, onSealUnwind) {
  if (nr === 56 || nr === 57 || nr === 58 || nr === 435) {
    return BigInt(-ENOSYS2);
  }
  if (nr === METHOD.SYS_THREAD && Number(a1) === YURT_THREAD_CREATE && resolvePendingThreadStackBounds) {
    const resolved = resolvePendingThreadStackBounds(Number(a3));
    if (resolved === 0) {
      abortReservedThreadStart?.(Number(a2), Number(a3));
      return BigInt(-EAGAIN);
    }
    a4 = encodeThreadStackBounds(resolved || void 0);
  }
  const envelope = packSyscallEnvelope(BigInt(nr), a1, a2, a3, a4, a5, a6);
  const envelopeView = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const rawResponseCap = nr === METHOD.SYS_THREAD && Number(a1) === 2 ? 4 : nr === LINUX_NR_RT_SIGTIMEDWAIT ? 32 : 0;
  const replay = new WorkerRawSyscallReplay(nr);
  let rc;
  let threadExitPrepareRounds = 0;
  let moduleRedispatchRounds = 0;
  while (true) {
    ({ rc } = relay(mailbox, pendingWake, replay.method, envelope, rawResponseCap));
    if (Number(rc) === SYSCALL_SEAL_UNWIND) {
      onSealUnwind?.();
      if (!seal) {
        throw new Error(`guestSyscall: sealed at syscall nr=${nr} but this guest lacks checkpoint support`);
      }
      if (threadExitPrepareRounds > 0) {
        continue;
      }
      try {
        seal.withhold(envelope);
      } catch (error) {
        if (!(error instanceof InvalidModuleExecutionState)) throw error;
        seal.refuse(error.message);
        continue;
      }
      return 0n;
    }
    if (replay.accept(rc)) continue;
    if (rc === WORKER_RPC_DEFERRED) {
      moduleRedispatchRounds++;
      if (moduleRedispatchRounds > GUEST_SYSCALL_MODULE_REDISPATCH_RETRY_CAP) {
        throw new Error(`guestSyscall: module redispatch retried more than ${GUEST_SYSCALL_MODULE_REDISPATCH_RETRY_CAP} times for syscall nr=${nr} \u2014 the coordinator is not making progress`);
      }
      const service = serviceModuleRedispatch(mailbox);
      if (service.state === "idle") {
        throw new Error(`guestSyscall: missing module request after a deferred reply for syscall nr=${nr} \u2014 invariant violation`);
      }
      if (service.state === "closed") {
        rc = service.errno;
        break;
      }
      continue;
    }
    const cookie = exitPreparationCookie(Number(rc), THREAD_EXIT_PREPARE_BASE, THREAD_EXIT_PREPARE_MAX);
    if (cookie !== void 0) {
      threadExitPrepareRounds++;
      if (threadExitPrepareRounds > GUEST_SYSCALL_THREAD_EXIT_PREPARE_RETRY_CAP) {
        throw new Error(`guestSyscall: THREAD_EXIT_PREPARE replayed more than ${GUEST_SYSCALL_THREAD_EXIT_PREPARE_RETRY_CAP} times for syscall nr=${nr} \u2014 the kernel is not making progress`);
      }
      releaseThreadStackForExit();
      afterThreadExitPrepare?.();
      envelopeView.setBigInt64(SYSCALL_ENVELOPE_OFFSET_A6, BigInt(cookie), true);
      continue;
    }
    if (Number(rc) === WORKER_SHARED_VFORK_EXEC_COMMITTED) {
      throw new SharedVforkExecRequested();
    }
    break;
  }
  throwIfProcessTerminated(rc);
  const threadExit = threadExitedValue(Number(rc));
  const isThreadCreate = nr === METHOD.SYS_THREAD && Number(a1) === YURT_THREAD_CREATE;
  if (threadExit !== void 0) {
    throw new GuestThreadExited(threadExit);
  }
  if (isThreadCreate && Number(rc) < 0) {
    abortReservedThreadStart?.(Number(a2), Number(a3));
  }
  return rc;
}
function releaseCurrentThreadStackForExit(instance, tid, afterSwitch) {
  const cleanupStackTop = instance.exports.yurt_pthread_cleanup_stack_top;
  const releaseThreadStack = instance.exports.yurt_pthread_release_thread_stack;
  const stackPointer = instance.exports.__stack_pointer;
  let switchedToCleanupStack = false;
  if (typeof cleanupStackTop === "function" && stackPointer instanceof WebAssembly.Global) {
    const stackTop = Number(cleanupStackTop(tid)) | 0;
    if (stackTop !== 0) {
      stackPointer.value = stackTop;
      switchedToCleanupStack = true;
    }
  }
  if (!switchedToCleanupStack) return;
  afterSwitch();
  if (typeof releaseThreadStack === "function") {
    releaseThreadStack(tid);
  }
}
function guestForkFamily(mailbox, pendingWake, bridge, callerTid, nr, a1, a2, a3, a4, a5, a6, relay = relayStructuredSyscall) {
  const envelope = packSyscallEnvelope(BigInt(nr), a1, a2, a3, a4, a5, a6);
  const replay = new WorkerRawSyscallReplay(nr);
  let reply;
  do {
    reply = relay(mailbox, pendingWake, replay.method, envelope, FORK_CONTINUATION_SIZE);
  } while (replay.accept(reply.rc));
  const { rc, response } = reply;
  if (Number(rc) === SYSCALL_SEAL_UNWIND) {
    throw new Error("guestForkFamily: a fork-family relay was answered with a seal");
  }
  if (Number(rc) !== FORK_PENDING) {
    throwIfProcessTerminated(rc);
    return rc;
  }
  const decision = decodeForkContinuation(response);
  if (decision === null) return BigInt(-EIO);
  return BigInt(bridge.hostFork(callerTid, decision));
}
function makeWorkerForkController(mailbox, pendingWake, sharedVforkByRelay = false) {
  const relaySnapshot = (snapshot) => {
    if (activeRuntimeLinkGate) leaveRuntimeLinkGuest(activeRuntimeLinkGate);
    mailbox.writePayload("request", encodeForkRelayRequest());
    beginRelay(mailbox);
    const runtimeRuns = activeRuntimeLinkOps?.pendingRuns() ?? [];
    self.postMessage({
      kind: "fork",
      snapshot: {
        ...snapshot,
        runtimeRuns
      }
    });
    waitForReply(mailbox, pendingWake);
    const reply = mailbox.readPayload("reply", RELAY_REPLY_BYTES);
    transitionMailbox(mailbox, "IDLE");
    if (activeRuntimeLinkGate) enterRuntimeLinkGuest(activeRuntimeLinkGate);
    return Number(new DataView(reply.buffer, reply.byteOffset, reply.byteLength).getBigInt64(0, true));
  };
  const terminalOf = (error) => error instanceof GuestProcessExited ? {
    terminal: "exit",
    exitCode: error.code
  } : error instanceof SharedVforkCompleted ? {
    terminal: "exit",
    exitCode: 0
  } : {
    terminal: "trap",
    exitCode: stoppedBy(error, "vfork child stopped")
  };
  if (sharedVforkByRelay) {
    return {
      // A copying fork from a pthread is refused with ENOSYS (#1715; see
      // `WorkerHost`'s thread "fork" arm). Refuse it here: asking by
      // `postMessage` parked the thread for ever under the synchronous
      // relay pump, which never sees the message (yurtos-kernel#3113).
      forkFromContinuation: () => -ENOSYS2,
      startSharedVfork: () => Number(relayStructuredSyscall(mailbox, pendingWake, SHARED_VFORK_START_METHOD, new Uint8Array(0), 0).rc),
      finishSharedVfork: (error) => {
        if (error instanceof SharedVforkExecRequested) return;
        const { terminal, exitCode } = terminalOf(error);
        relayStructuredSyscall(mailbox, pendingWake, SHARED_VFORK_FINISH_METHOD, encodeSharedVforkFinish(terminal, exitCode), 0);
      }
    };
  }
  return {
    forkFromContinuation: relaySnapshot,
    startSharedVfork: relaySnapshot,
    finishSharedVfork: (error) => {
      if (error instanceof SharedVforkExecRequested) return;
      const finish = error instanceof GuestProcessExited ? {
        kind: "vfork-finish",
        terminal: "exit",
        exitCode: error.code
      } : error instanceof SharedVforkCompleted ? {
        kind: "vfork-finish",
        terminal: "exit",
        exitCode: 0
      } : {
        kind: "vfork-finish",
        terminal: "trap",
        exitCode: stoppedBy(error, "vfork child stopped")
      };
      mailbox.writePayload("request", encodeForkRelayRequest());
      if (activeRuntimeLinkGate) leaveRuntimeLinkGuest(activeRuntimeLinkGate);
      beginRelay(mailbox);
      self.postMessage(finish);
      waitForReply(mailbox, pendingWake);
      transitionMailbox(mailbox, "IDLE");
      if (activeRuntimeLinkGate) enterRuntimeLinkGuest(activeRuntimeLinkGate);
    }
  };
}
function makeWorkerSealController(mailbox, pendingWake) {
  return {
    seal(snapshot) {
      if (activeRuntimeLinkGate) leaveRuntimeLinkGuest(activeRuntimeLinkGate);
      mailbox.writePayload("request", encodeForkRelayRequest());
      beginRelay(mailbox);
      self.postMessage({
        kind: "sealed",
        snapshot
      });
      waitForReply(mailbox, pendingWake);
      transitionMailbox(mailbox, "IDLE");
      if (activeRuntimeLinkGate) enterRuntimeLinkGuest(activeRuntimeLinkGate);
    }
  };
}
function refuseWorkerSeal(mailbox, pendingWake, reason) {
  if (activeRuntimeLinkGate) leaveRuntimeLinkGuest(activeRuntimeLinkGate);
  mailbox.writePayload("request", encodeForkRelayRequest());
  beginRelay(mailbox);
  self.postMessage({
    kind: "seal-refused",
    reason
  });
  waitForReply(mailbox, pendingWake);
  transitionMailbox(mailbox, "IDLE");
  if (activeRuntimeLinkGate) enterRuntimeLinkGuest(activeRuntimeLinkGate);
}
function threadTlsMappingSize(tlsSize, asyncifySize) {
  if (asyncifySize <= 0) return {
    total: tlsSize,
    asyncifyOffset: 0
  };
  const asyncifyOffset = Math.ceil(tlsSize / 16) * 16;
  const total = asyncifyOffset + asyncifySize;
  if (!Number.isSafeInteger(total) || total > 2147483647) {
    throw new Error("thread TLS mapping overflows the admission word");
  }
  return {
    total,
    asyncifyOffset
  };
}
function relayStructuredSyscall(mailbox, pendingWake, method, request, responseCap, notifyRequest) {
  if (activeRuntimeLinkGate) leaveRuntimeLinkGuest(activeRuntimeLinkGate);
  mailbox.writePayload("request", encodeStructuredRelayRequest(method, request, responseCap));
  beginRelay(mailbox);
  notifyRequest?.();
  self.postMessage({
    kind: "relay"
  });
  waitForReply(mailbox, pendingWake);
  const reply = decodeStructuredRelayReply(mailbox.readPayload("reply", mailbox.reply.byteLength));
  transitionMailbox(mailbox, "IDLE");
  if (activeRuntimeLinkGate) enterRuntimeLinkGuest(activeRuntimeLinkGate);
  if (reply.rc !== WORKER_RPC_DEFERRED) {
    servicePendingModuleOperation(mailbox);
  }
  return reply;
}
var MODULE_BYTES_CHUNK = 512 * 1024;
function workerBytesTransport(mailbox, pendingWake) {
  return runtimeLinkBytesTransport((method, request, responseCap) => relayRuntimeLinkCoordination(mailbox, pendingWake, method, request, responseCap));
}
function runtimeLinkBytesTransport(call) {
  return {
    uploadBegin(length) {
      const request = new Uint8Array(4);
      new DataView(request.buffer).setUint32(0, length, true);
      return Number(call(METHOD.WORKER_RUNTIME_LINK_UPLOAD_BEGIN, request, 0).rc);
    },
    uploadChunk(id, offset, bytes) {
      const request = new Uint8Array(8 + bytes.byteLength);
      const view = new DataView(request.buffer);
      view.setUint32(0, id, true);
      view.setUint32(4, offset, true);
      request.set(bytes, 8);
      return Number(call(METHOD.WORKER_RUNTIME_LINK_UPLOAD_CHUNK, request, 0).rc);
    },
    uploadAbort(id) {
      const request = new Uint8Array(4);
      new DataView(request.buffer).setUint32(0, id, true);
      call(METHOD.WORKER_RUNTIME_LINK_UPLOAD_ABORT, request, 0);
    },
    get(path, generation, offset, length) {
      const pathBytes = new TextEncoder().encode(path);
      const request = new Uint8Array(12 + pathBytes.byteLength);
      const view = new DataView(request.buffer);
      view.setUint32(0, generation, true);
      view.setUint32(4, offset, true);
      view.setUint32(8, length, true);
      request.set(pathBytes, 12);
      const result = call(METHOD.WORKER_RUNTIME_LINK_BYTES_GET, request, length);
      return result.rc < 0n ? Number(result.rc) : result.response.subarray(0, Number(result.rc)).slice();
    }
  };
}
function runtimeLinkBatchAnswer(result, operation) {
  if (result.rc === -BigInt(EAGAIN)) return false;
  if (result.rc < 0n) return Number(result.rc);
  return operation === "retire" ? decodeDroppedGenerations(result.response, Number(result.rc)) : true;
}
function batchRefused(result) {
  return result === false || batchRefusedFinally(result);
}
function batchRefusedFinally(result) {
  return typeof result === "number" && result < 0;
}
function decodeDroppedGenerations(response, length) {
  if (length < 4) return true;
  const view = new DataView(response.buffer, response.byteOffset, length);
  const count = view.getUint32(0, true);
  if (4 + 4 * count > length) return true;
  return Array.from({
    length: count
  }, (_, i) => view.getUint32(4 + 4 * i, true));
}
function readRuntimeLinkInput(call, id, length) {
  if (length <= 0 || length > MAX_MODULE_BYTES) return null;
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; ) {
    const want = Math.min(MODULE_BYTES_CHUNK, length - offset);
    const request = new Uint8Array(12);
    const view = new DataView(request.buffer);
    view.setUint32(0, id, true);
    view.setUint32(4, offset, true);
    view.setUint32(8, want, true);
    const reply = call(METHOD.WORKER_RUNTIME_LINK_INPUT_GET, request, want);
    const got = Number(reply.rc);
    if (reply.rc < 0n || got <= 0 || got > want) return null;
    out.set(reply.response.subarray(0, got), offset);
    offset += got;
  }
  return out;
}
function fetchRuntimeModuleOverRelay(call, path) {
  const encoded = new TextEncoder().encode(path);
  const opened = (payload) => {
    const decoded = payload === null ? null : decodeRuntimeModulePayload(payload);
    return decoded === null ? {
      kind: "error",
      errno: EIO
    } : {
      kind: "opened",
      path,
      bytes: decoded.bytes,
      ...decoded.file !== void 0 && {
        file: decoded.file
      }
    };
  };
  const inline = call(METHOD.WORKER_RUNTIME_DLOPEN, encoded, 1 << 20);
  if (inline.rc >= 0n) {
    return opened(inline.response.subarray(0, Number(inline.rc)));
  }
  if (inline.rc !== -BigInt(E2BIG)) {
    return {
      kind: "error",
      errno: Number(-inline.rc)
    };
  }
  const staged = call(METHOD.WORKER_RUNTIME_LINK_INPUT_STAGE, encoded, 8);
  if (staged.rc < 0n) return {
    kind: "error",
    errno: Number(-staged.rc)
  };
  if (staged.rc !== 8n || staged.response.byteLength < 8) {
    return {
      kind: "error",
      errno: EIO
    };
  }
  const view = new DataView(staged.response.buffer, staged.response.byteOffset, 8);
  const id = view.getUint32(0, true);
  try {
    return opened(readRuntimeLinkInput(call, id, view.getUint32(4, true)));
  } finally {
    const release = new Uint8Array(4);
    new DataView(release.buffer).setUint32(0, id, true);
    call(METHOD.WORKER_RUNTIME_LINK_INPUT_RELEASE, release, 0);
  }
}
function relayRuntimeLinkCoordination(mailbox, pendingWake, method, request, responseCap) {
  if (!servicingModuleOp) {
    return relayStructuredSyscall(mailbox, pendingWake, method, request, responseCap);
  }
  if (!isWorkerRuntimeLinkMethod(method)) {
    return {
      rc: -5n,
      response: new Uint8Array()
    };
  }
  const channel = activeRuntimeLinkCoordChannel;
  if (!channel) {
    return {
      rc: -5n,
      response: new Uint8Array()
    };
  }
  if (activeRuntimeLinkGate) leaveRuntimeLinkGuest(activeRuntimeLinkGate);
  try {
    return invokeWorkerRpc(channel, method, request, responseCap, {
      wakePeer: () => self.postMessage({
        kind: "runtime-link"
      })
    });
  } finally {
    if (activeRuntimeLinkGate) enterRuntimeLinkGuest(activeRuntimeLinkGate);
  }
}
var activeCompletion;
var activeCompletionSettled = false;
var activeRuntimeLinkGate;
var activeModuleOpChannel;
var activeRuntimeLinkCoordChannel;
var activeModuleOps;
var activeRuntimeLinkOps;
var activeInputReader;
var activeMailbox;
var imageSetupExecution;
var servicingModuleOp = false;
function runImageSetupGuest(run) {
  return withGuestImage(imageSetupExecution, run);
}
function runRuntimeLinkGuest(run) {
  const gate = activeRuntimeLinkGate;
  if (gate) enterRuntimeLinkGuest(gate);
  try {
    return run();
  } finally {
    if (gate) leaveRuntimeLinkGuest(gate);
  }
}
function reportTrap(error) {
  const code = stoppedBy(error);
  if (activeCompletion && !activeCompletionSettled) {
    activeCompletionSettled = true;
    settleCompletion(activeCompletion, code);
  }
  self.postMessage({
    kind: "trap",
    code
  });
}
function stoppedBy(error, who = "stopped") {
  const code = trapCompletionCode(error);
  console.error(`[yurt] ${workerLabel} ${who} (completion ${code}): ${describeTrap(error)}`);
  return code;
}
var workerLabel = "Worker (not initialised)";
function reportExit(code) {
  if (activeCompletion && !activeCompletionSettled) {
    activeCompletionSettled = true;
    settleCompletion(activeCompletion, code);
  }
  self.postMessage({
    kind: "exit",
    code
  });
}
function reportThreadExit(code) {
  if (activeCompletion && !activeCompletionSettled) {
    activeCompletionSettled = true;
    settleCompletion(activeCompletion, code, COMPLETION_KIND_THREAD);
  }
  self.postMessage({
    kind: "thread-exit",
    code
  });
}
if ("WorkerGlobalScope" in self) {
  self.onmessage = (ev) => {
    const msg = ev.data;
    try {
      if (msg.kind === "spare-ready") {
        const ready = new Int32Array(msg.readyBuffer);
        Atomics.store(ready, 0, 1);
        Atomics.notify(ready, 0);
        return;
      }
      if (msg.kind === "init") return handleInit(msg);
      if (msg.kind === "run") return handleRun();
      if (msg.kind === "thread-init") return handleThreadInit(msg);
      if (msg.kind === "thread-run") return handleThreadRun();
      if (msg.kind === "module-rpc") {
        if (activeMailbox) servicePendingModuleOperation(activeMailbox);
        return;
      }
    } catch (error) {
      reportTrap(error);
    }
  };
}
var pendingInstance;
var pendingStartupCtors = [];
var pendingExecutionModules = [];
var pendingThreadAsyncify;
function readStartupDylink(module) {
  const payload = singleDylinkPayload(WebAssembly.Module.customSections(module, "dylink.0").map((section) => new Uint8Array(section)));
  return payload === void 0 ? void 0 : parseDylinkPayload(new WasmCursor(payload));
}
function readStartupGlobalImports(bytes) {
  const globals = /* @__PURE__ */ new Map();
  let pos = 8;
  const readUleb = (end) => {
    let value = 0;
    let shift = 0;
    while (pos < end) {
      const byte = bytes[pos++];
      value |= (byte & 127) << shift;
      if ((byte & 128) === 0) return value >>> 0;
      shift += 7;
    }
    throw new Error("truncated startup import metadata");
  };
  const readName = (end) => {
    const length = readUleb(end);
    const next = pos + length;
    if (next > end) throw new Error("truncated startup import name");
    const name = new TextDecoder().decode(bytes.subarray(pos, next));
    pos = next;
    return name;
  };
  while (pos < bytes.length) {
    const sectionKind = bytes[pos++];
    const sectionLength = readUleb(bytes.length);
    const sectionEnd = pos + sectionLength;
    if (sectionEnd > bytes.length) throw new Error("truncated startup section");
    if (sectionKind !== 2) {
      pos = sectionEnd;
      continue;
    }
    const count = readUleb(sectionEnd);
    for (let index = 0; index < count; index++) {
      readName(sectionEnd);
      const name = readName(sectionEnd);
      const kind = bytes[pos++];
      if (kind === 0) readUleb(sectionEnd);
      else if (kind === 1) {
        pos++;
        const flags = readUleb(sectionEnd);
        readUleb(sectionEnd);
        if (flags & 1) readUleb(sectionEnd);
      } else if (kind === 2) {
        const flags = readUleb(sectionEnd);
        readUleb(sectionEnd);
        if (flags & 1) readUleb(sectionEnd);
      } else if (kind === 3) {
        const valueType = bytes[pos++];
        pos++;
        const numeric = valueType === 126 ? {
          descriptor: {
            value: "i64",
            mutable: true
          },
          initialValue: 0n
        } : valueType === 125 ? {
          descriptor: {
            value: "f32",
            mutable: true
          },
          initialValue: 0
        } : valueType === 124 ? {
          descriptor: {
            value: "f64",
            mutable: true
          },
          initialValue: 0
        } : valueType === 127 ? {
          descriptor: {
            value: "i32",
            mutable: true
          },
          initialValue: 0
        } : void 0;
        if (numeric) globals.set(name, numeric);
      } else if (kind === 4) {
        readUleb(sectionEnd);
        readUleb(sectionEnd);
      } else throw new Error(`unsupported startup import kind ${kind}`);
    }
    pos = sectionEnd;
  }
  return globals;
}
var startupFunctionNamesByPlan = /* @__PURE__ */ new WeakMap();
function startupFunctionNames(plan) {
  if (!plan) return /* @__PURE__ */ new Set();
  let names = startupFunctionNamesByPlan.get(plan);
  if (names) return names;
  names = /* @__PURE__ */ new Set();
  for (const entry of plan.modules) {
    for (const exp of WebAssembly.Module.exports(new WebAssembly.Module(entry.bytes))) {
      if (exp.kind === "function" && !ASYNCIFY_EXPORTS.some((name) => name === exp.name)) names.add(exp.name);
    }
  }
  startupFunctionNamesByPlan.set(plan, names);
  return names;
}
function installStartupImportStubs(module, imports, symbols, plan, replace = /* @__PURE__ */ new Set(), forwardUnprovidedEnv = false) {
  const startupNames = startupFunctionNames(plan);
  const object = imports;
  const forwarded = [];
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== "function") continue;
    const unprovidedEnv = forwardUnprovidedEnv && imp.module === "env" && object.env?.[imp.name] === void 0;
    if (!startupNames.has(imp.name) && !unprovidedEnv) continue;
    const moduleImports = object[imp.module] ?? {};
    object[imp.module] = moduleImports;
    if (moduleImports[imp.name] !== void 0 && !replace.has(`${imp.module}\0${imp.name}`)) continue;
    moduleImports[imp.name] = (...args) => {
      const resolved = symbols.get(imp.name);
      if (typeof resolved !== "function") {
        throw new Error(`startup symbol '${imp.name}' not loaded`);
      }
      return resolved(...args);
    };
    if (imp.module === "env") forwarded.push(imp.name);
  }
  return forwarded;
}
function installStartupGlobalImportStubs(imports, globals) {
  const stubs = /* @__PURE__ */ new Map();
  const object = imports;
  for (const imp of globals ?? []) {
    const moduleImports = object[imp.module] ?? {};
    object[imp.module] = moduleImports;
    if (moduleImports[imp.name] instanceof WebAssembly.Global) continue;
    const stub = new WebAssembly.Global(imp.descriptor, imp.initialValue);
    moduleImports[imp.name] = stub;
    stubs.set(`${imp.module}\0${imp.name}`, stub);
  }
  return stubs;
}
function resolveStartupGlobalStubs(stubs, symbols, globals, table, requester = "", mainWeak = /* @__PURE__ */ new Set(), strictEnv = false) {
  for (const imp of globals ?? []) {
    const stub = stubs.get(`${imp.module}\0${imp.name}`);
    const value = symbols.get(imp.name);
    if (!stub) continue;
    if (value === void 0) {
      if (mainWeak.has(imp.name)) continue;
      if (imp.module === "GOT.mem" || imp.module === "GOT.func") {
        throw new LoaderRelocationError(requester, imp.name, `startup symbol '${imp.name}' not found`);
      }
      if (strictEnv) throw new LoaderRelocationError(requester, imp.name);
      continue;
    }
    const resolved = dsoImportValue({
      module: imp.module,
      name: imp.name,
      kind: "global"
    }, value, () => table ? existingFunctionTableSlot(table, value) : void 0);
    if (resolved === void 0) {
      throw new LoaderRelocationError(requester, imp.name, `startup symbol '${imp.name}' has no GOT address`);
    }
    bindDsoGlobalAlias(stub, resolved);
  }
}
function executableDataRelocations(instance) {
  const relocate = instance.exports.__wasm_apply_data_relocs;
  return typeof relocate === "function" ? relocate : void 0;
}
function runStartupConstructors(constructors, skip, execution) {
  if (skip || constructors.length === 0) return;
  withGuestImage(execution, () => {
    for (const ctor of constructors.splice(0)) ctor();
  });
}
function reserveWorkerMainFunctionSlot(mailbox, pendingWake, name, minimumTableBase) {
  const nameBytes = new TextEncoder().encode(name);
  const request = new Uint8Array(4 + nameBytes.length);
  new DataView(request.buffer).setUint32(0, minimumTableBase, true);
  request.set(nameBytes, 4);
  const result = relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_SYMBOL, request, 0);
  return result.rc >= 0n ? Number(result.rc) : void 0;
}
var startupResidents = /* @__PURE__ */ new WeakMap();
function loadStartupLinkPlan(plan, memory, mainInstance, symbols = /* @__PURE__ */ new Map(), options = {}) {
  const progress = {
    needed: /* @__PURE__ */ new Map()
  };
  try {
    return linkStartupPlan(plan, memory, mainInstance, symbols, options, progress);
  } catch (error) {
    const requesters = options.requesters;
    const failed = progress.current;
    if (isLoaderError(error) || !requesters || failed === void 0) {
      throw error;
    }
    if (error instanceof DsoMissingImportError) {
      throw new LoaderRelocationError(failed, error.symbol);
    }
    const { requester, needed } = startupRequester(plan, failed, requesters, progress.needed);
    throw new LoaderLoadError(needed, requester, ENOEXEC, {
      cause: error
    });
  }
}
function startupRequester(plan, path, requesters, neededBy) {
  const names = /* @__PURE__ */ new Set([
    path,
    path.slice(path.lastIndexOf("/") + 1)
  ]);
  const match = (list) => list.find((name) => names.has(name));
  const fromMain = match(requesters.mainNeeded);
  if (fromMain !== void 0) {
    return {
      requester: requesters.main,
      needed: fromMain
    };
  }
  for (const entry of plan?.modules ?? []) {
    if (entry.path === path) break;
    const found = match(neededBy.get(entry.path) ?? []);
    if (found !== void 0) return {
      requester: entry.path,
      needed: found
    };
  }
  return {
    requester: requesters.main,
    needed: path
  };
}
function linkStartupPlan(plan, memory, mainInstance, symbols, options, progress) {
  const initializers = [];
  const constructors = [];
  const tlsInitializers = [];
  const earlyInit = [];
  const deferredGot = [];
  if (!plan || plan.modules.length === 0) return initializers;
  const residents = /* @__PURE__ */ new Map();
  startupResidents.set(memory, residents);
  for (const [name, value] of Object.entries(mainInstance.exports)) {
    if (!ASYNCIFY_EXPORTS.some((exportName) => exportName === name)) {
      symbols.set(name, value);
    }
  }
  const table = mainInstance.exports.__indirect_function_table;
  const wasmTable = table instanceof WebAssembly.Table ? table : void 0;
  const functionAddresses = /* @__PURE__ */ new Map();
  const mainFunctionSlots = () => options.mainFunctionSlots ?? plan.mainFunctionSlots;
  const functionAddress = (value, name) => {
    if (typeof value !== "function" || !wasmTable) return void 0;
    const cached = functionAddresses.get(value);
    if (cached !== void 0) return cached;
    const mainSymbol = mainInstance.exports[name] === value;
    const index = (mainSymbol ? mainFunctionSlots()?.[name] : void 0) ?? existingFunctionTableSlot(wasmTable, value) ?? wasmTable.grow(1);
    if (wasmTable.length <= index) wasmTable.grow(index + 1 - wasmTable.length);
    if (mainSymbol) {
      (options.mainFunctionSlots ?? (plan.mainFunctionSlots ??= {}))[name] = index;
    }
    wasmTable.set(index, value);
    functionAddresses.set(value, index);
    return index;
  };
  const startupGlobalStubs = /* @__PURE__ */ new Map();
  const libraryGlobalStubs = [];
  for (const entry of plan.modules) {
    progress.current = entry.path;
    for (const [name, global2] of readStartupGlobalImports(entry.bytes)) {
      if (symbols.has(name) || startupGlobalStubs.has(name)) continue;
      startupGlobalStubs.set(name, new WebAssembly.Global(global2.descriptor, global2.initialValue));
    }
  }
  const rollbacks = [];
  try {
    for (const [loadIndex, entry] of plan.modules.entries()) {
      progress.current = entry.path;
      validateNoLegacyGrowthImports(entry.bytes);
      validateNoDirectMemoryGrow(entry.bytes);
      validateStartFunctionDoesNoWork(entry.bytes);
      validateNoRuntimeMutableGlobals(entry.bytes, "startup");
      const module = new WebAssembly.Module(neutraliseStartWaits(entry.bytes));
      const dylink = readStartupDylink(module);
      if (!dylink) throw new Error("startup side module missing dylink.0");
      progress.needed.set(entry.path, dylink.needed);
      const { memSize, tableSize } = dylink;
      const reuseLayout = options.reuseLayout === true;
      const memoryBase = entry.memoryBase ?? 0;
      if (memSize > 0 && entry.memoryBase === void 0) {
        throw new Error(`startup side module ${entry.path} has no reserved data area`);
      }
      if (memSize > 0 && (entry.memorySize !== void 0 && memSize > entry.memorySize || memoryBase + memSize > memory.buffer.byteLength)) {
        throw new Error(`startup side module ${entry.path} needs ${memSize} bytes at ${memoryBase}, beyond its reserved data area`);
      }
      const functionExports = dsoFunctionExports(module);
      const ownDeferredGot = [];
      const tableBase = wasmTable ? entry.tableBase ?? wasmTable.grow(tableSize + functionExports.length) : 0;
      const tableEnd = tableBase + tableSize + functionExports.length;
      if (wasmTable && wasmTable.length < tableEnd) {
        wasmTable.grow(tableEnd - wasmTable.length);
      }
      if (wasmTable) {
        rollbacks.push(() => {
          for (let i = tableBase; i < tableEnd; i++) wasmTable.set(i, null);
        });
      }
      if (!reuseLayout) {
        const priorTable = entry.tableBase;
        rollbacks.push(() => {
          entry.tableBase = priorTable;
        });
        entry.tableBase = tableBase;
      }
      const weakImports = dsoWeakImports(module);
      const bound = bindDso({
        bytes: entry.bytes,
        module,
        memory,
        table: wasmTable,
        memoryBase,
        tableBase,
        tableSize,
        symbol: (name) => symbols.get(name),
        functionAddress: (name, value) => functionAddress(value, name),
        // A re-export answers the address an earlier library's function
        // already has (#3854); a main function's is functionAddress's.
        existingFunctionSlot: (name, value) => mainInstance.exports[name] === value ? void 0 : functionAddresses.get(value),
        missingGlobal: (imp) => {
          const stub = startupGlobalStubs.get(imp.name);
          if (stub) {
            libraryGlobalStubs.push({
              owner: entry.path,
              name: imp.name,
              weak: weakImports.has(imp.name),
              stub
            });
          }
          return stub;
        },
        deferredGot: ownDeferredGot,
        initializerMode: reuseLayout ? "shared" : "replay",
        runConstructors: options.runConstructors
      });
      for (const cell of ownDeferredGot) {
        deferredGot.push({
          ...cell,
          owner: entry.path
        });
      }
      const instance = bound.instance;
      const earlyEntry = instance.exports.__yurt_libc_early_init;
      if (!reuseLayout && typeof earlyEntry === "function") {
        earlyInit.push(earlyEntry);
      }
      options.executionModules?.push({
        identity: {
          kind: "dso",
          loadIndex,
          path: entry.path
        },
        instance
      });
      if (!reuseLayout) {
        const tls = startupTlsInitializer(memory, {
          identity: {
            kind: "dso",
            loadIndex,
            path: entry.path
          },
          instance
        }, entry.tlsBase, startupTlsExtent(entry));
        if (tls) tlsInitializers.push(tls);
      }
      for (const initialize of bound.initializers) {
        initializers.push(initialize);
      }
      if (bound.tlsRebase) initializers.push(bound.tlsRebase);
      for (const construct of bound.constructors) constructors.push(construct);
      const resident = {
        entry: {
          path: entry.path,
          bytes: entry.bytes,
          ...entry.file !== void 0 && {
            file: entry.file
          },
          generation: -(residents.size + 1),
          memoryBase,
          memorySize: memSize,
          tableBase,
          tableSize,
          needed: dylink.needed,
          refCount: 1,
          opens: 0,
          global: true,
          nodelete: true
        },
        instance,
        symbols: /* @__PURE__ */ new Map(),
        slots: /* @__PURE__ */ new Map()
      };
      residents.set(entry.path, resident);
      rollbacks.push(() => residents.delete(entry.path));
      for (const [name, symbol] of bound.symbols) {
        resident.symbols.set(name, symbol.value);
        if (typeof symbol.value === "function" && symbol.dlsym !== void 0) {
          resident.slots.set(name, symbol.dlsym);
        }
        if (typeof symbol.value === "function" && symbol.dlsym !== void 0) {
          functionAddresses.set(symbol.value, symbol.dlsym);
        }
        if (!Object.hasOwn(mainInstance.exports, name) && !symbols.has(name)) {
          rollbacks.push(() => symbols.delete(name));
          symbols.set(name, symbol.value);
          options.definers?.set(name, entry.bytes);
        }
      }
    }
    progress.current = void 0;
    resolveDeferredDsoGot(deferredGot, (name) => symbols.get(name), (name, value) => functionAddress(value, name));
    for (const { owner, name, weak, stub } of libraryGlobalStubs) {
      const value = symbols.get(name);
      if (value instanceof WebAssembly.Global) {
        try {
          bindDsoGlobalAlias(stub, value);
        } catch (error) {
          throw new LoaderRelocationError(owner, name, `startup symbol '${name}' has no value of the imported type (imported by ${owner}): ${error}`);
        }
        continue;
      }
      if ((value !== void 0 || !weak) && options.requesters) {
        throw new LoaderRelocationError(owner, name);
      }
    }
  } catch (error) {
    for (const undo of rollbacks.toReversed()) undo();
    throw error;
  }
  return initializers.concat(tlsInitializers, earlyInit, constructors);
}
function enterInitGate(gate) {
  tryEnterRuntimeLinkGuest(gate);
}
function handleInit(msg) {
  workerLabel = `pid ${msg.pid} Worker`;
  activeRuntimeLinkGate = msg.runtimeLinkGateBuffer;
  activeModuleOpChannel = wrapWorkerModuleOpChannel(msg.moduleOpBuffer);
  activeRuntimeLinkCoordChannel = wrapWorkerRuntimeLinkChannel(msg.runtimeLinkCoordBuffer);
  activeModuleOps = void 0;
  activeInputReader = void 0;
  enterInitGate(msg.runtimeLinkGateBuffer);
  const readyArr = new Int32Array(msg.readyBuffer);
  const pendingWake = new Int32Array(msg.pendingWakeBuffer);
  const testExitPreparationGate = msg.testExitPreparationGate === void 0 ? void 0 : new Int32Array(msg.testExitPreparationGate);
  activeCompletion = new Int32Array(msg.completionBuffer);
  activeCompletionSettled = false;
  pendingStartupCtors = [];
  pendingExecutionModules = [];
  pendingActivation = void 0;
  try {
    const mailbox = wrapMailbox(msg.mailboxBuffer);
    activeMailbox = mailbox;
    imageSetupExecution = msg.forkSnapshot !== void 0 || msg.sealSnapshot !== void 0 ? void 0 : createImageSetupExecutionControl((phase) => {
      const request = new Uint8Array(4);
      new DataView(request.buffer).setUint32(0, phase, true);
      const reply = relayStructuredSyscall(mailbox, pendingWake, IMAGE_SETUP_EXECUTION_METHOD, request, 0);
      if (reply.rc < 0n) {
        throw new Error(`image setup boundary failed: rc=${reply.rc}`);
      }
      return reply.rc === 1n;
    });
    if (msg.forkSnapshot === void 0 && msg.sealSnapshot === void 0) {
      checkYurtImportTypes(msg.module, msg.yurtFunctionImportTypes);
    }
    const instanceRef = {};
    const imports = buildGuestImports(msg.module, msg.memory, msg.argv, msg.env, msg.auxv, () => {
      const table = instanceRef.value?.exports.__indirect_function_table;
      return table instanceof WebAssembly.Table ? table : void 0;
    }, msg.runtimeLinkPlan, (name) => instanceRef.value?.exports[name], (path) => fetchRuntimeModuleOverRelay((method, request, responseCap) => relayRuntimeLinkCoordination(mailbox, pendingWake, method, request, responseCap), path), () => {
      const result = relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_PLAN, new Uint8Array(), 1 << 20);
      return result.rc >= 0n ? decodeRuntimeLinkPlan(result.response.subarray(0, Number(result.rc))) : Number(result.rc);
    }, (record) => {
      const result = relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_PUBLISH, encodeRuntimeLinkPlan({
        modules: [
          record
        ]
      }), 0);
      return result.rc >= 0n;
    }, {
      policy: normalizeLoaderPolicy(msg.loaderPolicy),
      cwd: () => workerCwd(mailbox, pendingWake, msg.env)
    }, (record) => {
      const result = relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_RETIRE, encodeRuntimeLinkPlan({
        modules: [
          {
            path: record.path,
            bytes: new Uint8Array(),
            generation: record.generation,
            memoryBase: 0,
            memorySize: 0,
            tableBase: 0,
            tableSize: 0,
            refCount: 0,
            opens: 0,
            global: false,
            nodelete: false,
            needed: []
          }
        ]
      }), 0);
      return result.rc >= 0n;
    }, (record) => {
      const result = relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_RETAIN, encodeRuntimeLinkPlan({
        modules: withoutResendableBytes([
          record
        ], "promote")
      }), 0);
      return result.rc >= 0n;
    }, (records, operation) => {
      const result = relayRuntimeLinkCoordination(mailbox, pendingWake, operation === "retire" ? METHOD.WORKER_RUNTIME_LINK_RETIRE : operation === "promote" ? METHOD.WORKER_RUNTIME_LINK_PROMOTE : METHOD.WORKER_RUNTIME_LINK_PUBLISH, encodeRuntimeLinkPlan({
        modules: withoutResendableBytes(records, operation)
      }, {
        bytes: "none"
      }), operation === "retire" ? 4 + 4 * records.length : 0);
      return runtimeLinkBatchAnswer(result, operation);
    }, (path, tableLength, minimumTableBase) => {
      const pathBytes = new TextEncoder().encode(path);
      const request = new Uint8Array(12 + pathBytes.length);
      const requestView = new DataView(request.buffer);
      requestView.setUint32(0, tableLength, true);
      requestView.setUint32(4, minimumTableBase, true);
      requestView.setUint32(8, pathBytes.length, true);
      request.set(pathBytes, 12);
      let result;
      for (let attempt = 0; attempt < 4096; attempt++) {
        result = relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_RESERVE, request, 12);
        if (result.rc !== -BigInt(EAGAIN)) break;
      }
      if (result?.rc !== 12n) return void 0;
      const responseView = new DataView(result.response.buffer, result.response.byteOffset, 12);
      return {
        generation: responseView.getUint32(0, true),
        tableBase: responseView.getUint32(4, true),
        existing: responseView.getUint32(8, true) !== 0
      };
    }, (path) => {
      relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_ABORT, new TextEncoder().encode(path), 0);
    }, (name, minimum) => reserveWorkerMainFunctionSlot(mailbox, pendingWake, name, minimum), `${msg.pid}:${msg.pid}`, workerBytesTransport(mailbox, pendingWake), (key2) => void relayStructuredSyscall(mailbox, pendingWake, METHOD.KERNEL_MODULE_CONSTRUCTED, constructedRequest(key2), 0));
    imports.env.sys_setrlimit = (resource, soft, hard) => workerSetRlimit(mailbox, pendingWake, resource, soft, hard);
    const releaseLeaderThreadStackForExit = () => {
      if (pendingInstance) {
        releaseCurrentThreadStackForExit(pendingInstance, msg.pid, () => imports.yurt[RUNTIME_LINK_OPS]?.abortPendingLoads());
      }
    };
    const resolveLeaderPendingThreadStackTop = (startIndex) => resolvePthreadStartStackBounds((name) => instanceRef.value?.exports[name], startIndex);
    const abortLeaderReservedThreadStart = (fnPtr, startIndex) => abortReservedPthreadStartForCreate((name) => instanceRef.value?.exports[name], fnPtr, startIndex);
    const checkpointState = new CheckpointState({
      pid: msg.pid,
      tid: msg.pid,
      module: {
        kind: "main"
      }
    }, msg.checkpointSupported, {
      rewindPending: () => asyncifyBridge.sealRewindPending(),
      finishRewind: () => asyncifyBridge.finishSealRewind(),
      unwind: (pending) => asyncifyBridge.hostSeal(pending)
    });
    const signalPolls = signalPollAnswererFor(mailbox);
    const leaderSealHooks = {
      withhold: (envelope) => {
        asyncifyBridge.validateSealExecutionState();
        checkpointState.withhold(envelope);
        signalPolls.withheld();
      },
      refuse: (reason) => refuseWorkerSeal(mailbox, pendingWake, reason)
    };
    imports.yurt.host_checkpoint = () => checkpointState.checkpoint();
    imports.yurt.syscall = (nr, a1, a2, a3, a4, a5, a6) => signalPolls.syscall(nr, a1, () => guestSyscall(mailbox, pendingWake, nr, a1, a2, a3, a4, a5, a6, relayStructuredSyscall, releaseLeaderThreadStackForExit, resolveLeaderPendingThreadStackTop, abortLeaderReservedThreadStart, servicePendingModuleOperationDetailed, leaderSealHooks, testExitPreparationGate === void 0 ? void 0 : () => {
      Atomics.store(testExitPreparationGate, 0, 1);
      Atomics.notify(testExitPreparationGate, 0);
      while (Atomics.load(testExitPreparationGate, 0) !== 2) {
        guestWait(testExitPreparationGate, 0, 1);
      }
    }, testExitPreparationGate === void 0 ? void 0 : () => {
      Atomics.store(testExitPreparationGate, 0, 3);
      Atomics.notify(testExitPreparationGate, 0);
    }));
    imports.yurt.syscall_fork_family = (nr, a1, a2, a3, a4, a5, a6) => guestForkFamily(mailbox, pendingWake, asyncifyBridge, msg.pid, nr, a1, a2, a3, a4, a5, a6);
    asyncifyBridge.setForkController(makeWorkerForkController(mailbox, pendingWake));
    asyncifyBridge.setSealController(makeWorkerSealController(mailbox, pendingWake));
    const loaderSyscall = (nr, a1, a2, a3, a4, a5, a6) => guestSyscall(mailbox, pendingWake, nr, a1, a2, a3, a4, a5, a6);
    const startupSymbols = /* @__PURE__ */ new Map();
    const startupGlobalStubs = installStartupGlobalImportStubs(imports, msg.startupGlobalImports);
    if (imageSetupExecution) {
      for (const namespace of Object.values(imports)) {
        wrapImageExecutionImports(namespace, imageSetupExecution);
      }
    }
    const forwardedMainFunctions = installStartupImportStubs(msg.module, imports, startupSymbols, msg.startupLinkPlan, void 0, true);
    instanceRef.value = new WebAssembly.Instance(msg.module, imports);
    const runtimeLinkOps = imports.yurt[RUNTIME_LINK_OPS];
    activeModuleOps = runtimeLinkOps?.moduleOps;
    activeRuntimeLinkOps = runtimeLinkOps;
    activeInputReader = (id, length) => readRuntimeLinkInput((method, request, responseCap) => relayRuntimeLinkCoordination(mailbox, pendingWake, method, request, responseCap), id, length);
    for (const [name, value] of Object.entries(instanceRef.value.exports)) {
      if (!ASYNCIFY_EXPORTS.some((exportName) => exportName === name)) {
        startupSymbols.set(name, value);
      }
    }
    const resumesContinuation = msg.forkSnapshot !== void 0 || msg.sealSnapshot !== void 0;
    const instance = instanceRef.value;
    const mainTable = instance.exports.__indirect_function_table instanceof WebAssembly.Table ? instance.exports.__indirect_function_table : void 0;
    pendingInstance = instance;
    if (!resumesContinuation) {
      setStartupState(msg.startupLayoutBuffer, STARTUP_STATE_LOADING);
      const setup = imageSetupExecution;
      const loader = {
        needed: forwardedMainFunctions.length > 0 || (msg.startupGlobalImports?.length ?? 0) > 0 || (msg.startupLinkPlan?.modules.length ?? 0) > 0 || msg.startupPendingFailure !== void 0,
        run: () => {
          const pending = msg.startupPendingFailure;
          if (pending !== void 0) {
            throw new LoaderLoadError(pending.libName, pending.requester ?? mainImageName(msg.argv), pending.errno);
          }
          const definers = /* @__PURE__ */ new Map();
          pendingStartupCtors = pendingStartupCtors.concat(loadStartupLinkPlan(msg.startupLinkPlan, msg.memory, instance, startupSymbols, {
            runConstructors: true,
            executionModules: pendingExecutionModules,
            requesters: {
              main: mainImageName(msg.argv),
              mainNeeded: readStartupDylink(msg.module)?.needed ?? []
            },
            definers
          }));
          const mainWeak = dsoWeakImports(msg.module);
          resolveStartupGlobalStubs(startupGlobalStubs, startupSymbols, msg.startupGlobalImports, mainTable, mainImageName(msg.argv), mainWeak, true);
          checkForwardedMainFunctions(forwardedMainFunctions, startupSymbols, definers, msg.startupFunctionImportTypes, mainWeak, mainImageName(msg.argv));
        },
        syscall: loaderSyscall
      };
      pendingActivation = () => activateFreshImage(msg, instance, runtimeLinkOps, setup, loader);
      Atomics.store(readyArr, 0, READY_OK);
      Atomics.notify(readyArr, 0);
      return;
    }
    pendingStartupCtors = pendingStartupCtors.concat(loadStartupLinkPlan(msg.startupLinkPlan, msg.memory, instance, startupSymbols, {
      reuseLayout: true,
      runConstructors: false,
      executionModules: pendingExecutionModules
    }));
    resolveStartupGlobalStubs(startupGlobalStubs, startupSymbols, msg.startupGlobalImports, mainTable, "", dsoWeakImports(msg.module));
    pendingStartupCtors = [];
    pendingActivation = void 0;
    if (runtimeLinkOps) {
      const rc = runtimeLinkOps.materialize();
      if (rc !== 0) throw new Error("runtime-link materialization failed");
      const adopted = runtimeLinkOps.adoptPendingRuns(msg.forkSnapshot?.runtimeRuns ?? []);
      if (adopted !== 0) {
        throw new Error(`runtime-link run adoption failed (${adopted})`);
      }
    }
    writeStartupLayout(msg.startupLayoutBuffer, msg.startupLinkPlan, msg.module);
    setStartupState(msg.startupLayoutBuffer, STARTUP_STATE_PUBLISHED);
    asyncifyReady = initAsyncifyBridge(asyncifyBridge, instance, msg.memory, void 0, mainExecutionBindings(instance, msg.memory, pendingExecutionModules, pendingThreadStackBounds), runtimeLinkOps?.asyncify);
    if (msg.forkSnapshot !== void 0) {
      if (!asyncifyReady) {
        throw new Error("fork child instance has no Asyncify machinery");
      }
      asyncifyBridge.restoreForkSnapshot(msg.forkSnapshot, 0);
      asyncifyBridge.startForkRewind();
    }
    if (msg.sealSnapshot !== void 0) {
      if (!asyncifyReady) {
        throw new Error("restored instance has no Asyncify machinery to rewind its checkpoint");
      }
      checkpointState.restore(msg.sealSnapshot.checkpoint);
      asyncifyBridge.restoreSealSnapshot(msg.sealSnapshot);
      asyncifyBridge.startSealRewind();
    }
    setStartupState(msg.startupLayoutBuffer, STARTUP_STATE_SEAL_READY);
    Atomics.store(readyArr, 0, READY_OK);
    Atomics.notify(readyArr, 0);
  } catch {
    Atomics.store(readyArr, 0, READY_FAILED);
    Atomics.notify(readyArr, 0);
  } finally {
    leaveRuntimeLinkGuest(msg.runtimeLinkGateBuffer);
  }
}
var pendingActivation;
function activateFreshImage(msg, instance, runtimeLinkOps, setup, loader) {
  try {
    if (loader.needed) loader.run();
  } catch (error) {
    if (!isLoaderError(error)) throw error;
    reportLoaderFailure(msg.memory, error, loader.syscall);
  }
  writeStartupLayout(msg.startupLayoutBuffer, msg.startupLinkPlan, msg.module);
  setStartupState(msg.startupLayoutBuffer, STARTUP_STATE_PUBLISHED);
  if (runtimeLinkOps) {
    if ((msg.runtimeLinkPlan?.modules.length ?? 0) !== 0) {
      throw new Error("a fresh image inherited runtime-linked modules");
    }
    const rc = runtimeLinkOps.materialize();
    if (rc !== 0) throw new Error("runtime-link materialization failed");
  }
  if (msg.deferredStartExport !== void 0) {
    const start = instance.exports[msg.deferredStartExport];
    if (typeof start !== "function") {
      throw new Error(`WorkerHost leader init: deferred start export '${msg.deferredStartExport}' missing`);
    }
    withGuestImage(setup, start);
  }
  const relocate = executableDataRelocations(instance);
  if (relocate) withGuestImage(setup, relocate);
  asyncifyReady = initAsyncifyBridge(asyncifyBridge, instance, msg.memory, void 0, mainExecutionBindings(instance, msg.memory, pendingExecutionModules, pendingThreadStackBounds), runtimeLinkOps?.asyncify);
  setStartupState(msg.startupLayoutBuffer, STARTUP_STATE_SEAL_READY);
}
function checkForwardedMainFunctions(names, symbols, definers, mainTypes, mainWeak, main) {
  for (const name of names) {
    if (typeof symbols.get(name) !== "function") {
      if (mainWeak.has(name)) continue;
      throw new LoaderRelocationError(main, name);
    }
    const definer = definers.get(name);
    const definition = definer === void 0 ? void 0 : exportFunctionType(definer, name);
    const wanted = mainTypes?.[name];
    if (wanted === void 0 || wanted !== definition) {
      throw new LoaderRelocationError(main, name);
    }
  }
}
function mainImageName(argv) {
  return argv[0] === void 0 ? "" : new TextDecoder().decode(argv[0]);
}
function handleRun() {
  const instance = pendingInstance;
  if (!instance) {
    reportTrap();
    return;
  }
  try {
    runRuntimeLinkGuest(() => {
      const activate = pendingActivation;
      pendingActivation = void 0;
      activate?.();
      runStartupConstructors(pendingStartupCtors, false, imageSetupExecution);
    });
    const start = instance.exports._start;
    if (typeof start === "function") {
      runRuntimeLinkGuest(() => {
        if (asyncifyReady) {
          asyncifyBridge.wrapExportSyncDrive(() => {
            completeImageActivation(imageSetupExecution);
            return start();
          })();
        } else {
          completeImageActivation(imageSetupExecution);
          start();
        }
      });
    } else {
      completeImageActivation(imageSetupExecution);
    }
    reportExit(0);
  } catch (err) {
    if (err instanceof GuestProcessExited) {
      reportExit(err.code);
      return;
    }
    if (err instanceof GuestThreadExited) {
      reportThreadExit(err.code);
      return;
    }
    reportTrap(err);
  }
}
var pendingThreadInstance;
var pendingThreadMailbox;
var pendingThreadPendingWake;
var pendingThreadMemory;
var pendingThreadArg = 0;
var pendingThreadStackBounds;
var pendingThreadTlsLayout;
function handleThreadInit(msg) {
  workerLabel = `pid ${msg.pid} tid ${msg.tid} Worker`;
  activeRuntimeLinkGate = msg.runtimeLinkGateBuffer;
  activeModuleOpChannel = wrapWorkerModuleOpChannel(msg.moduleOpBuffer);
  activeRuntimeLinkCoordChannel = wrapWorkerRuntimeLinkChannel(msg.runtimeLinkCoordBuffer);
  activeModuleOps = void 0;
  activeInputReader = void 0;
  imageSetupExecution = void 0;
  enterInitGate(msg.runtimeLinkGateBuffer);
  const readyArr = new Int32Array(msg.readyBuffer);
  const pendingWake = new Int32Array(msg.pendingWakeBuffer);
  activeCompletion = new Int32Array(msg.completionBuffer);
  activeCompletionSettled = false;
  try {
    const mailbox = wrapMailbox(msg.mailboxBuffer);
    activeMailbox = mailbox;
    const instanceRef = {};
    const imports = buildGuestImports(msg.module, msg.memory, msg.argv, msg.env, msg.auxv, () => {
      const table = instanceRef.value?.exports.__indirect_function_table;
      return table instanceof WebAssembly.Table ? table : void 0;
    }, msg.runtimeLinkPlan, (name) => instanceRef.value?.exports[name], (path) => fetchRuntimeModuleOverRelay((method, request, responseCap) => relayRuntimeLinkCoordination(mailbox, pendingWake, method, request, responseCap), path), () => {
      const result = relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_PLAN, new Uint8Array(), 1 << 20);
      return result.rc >= 0n ? decodeRuntimeLinkPlan(result.response.subarray(0, Number(result.rc))) : Number(result.rc);
    }, (record) => {
      const result = relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_PUBLISH, encodeRuntimeLinkPlan({
        modules: [
          record
        ]
      }), 0);
      return result.rc >= 0n;
    }, {
      policy: normalizeLoaderPolicy(msg.loaderPolicy),
      cwd: () => workerCwd(mailbox, pendingWake, msg.env)
    }, (record) => {
      const result = relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_RETIRE, encodeRuntimeLinkPlan({
        modules: [
          {
            path: record.path,
            bytes: new Uint8Array(),
            generation: record.generation,
            memoryBase: 0,
            memorySize: 0,
            tableBase: 0,
            tableSize: 0,
            refCount: 0,
            opens: 0,
            global: false,
            nodelete: false,
            needed: []
          }
        ]
      }), 0);
      return result.rc >= 0n;
    }, (record) => {
      const result = relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_RETAIN, encodeRuntimeLinkPlan({
        modules: withoutResendableBytes([
          record
        ], "promote")
      }), 0);
      return result.rc >= 0n;
    }, (records, operation) => {
      const result = relayRuntimeLinkCoordination(mailbox, pendingWake, operation === "retire" ? METHOD.WORKER_RUNTIME_LINK_RETIRE : operation === "promote" ? METHOD.WORKER_RUNTIME_LINK_PROMOTE : METHOD.WORKER_RUNTIME_LINK_PUBLISH, encodeRuntimeLinkPlan({
        modules: withoutResendableBytes(records, operation)
      }, {
        bytes: "none"
      }), operation === "retire" ? 4 + 4 * records.length : 0);
      return runtimeLinkBatchAnswer(result, operation);
    }, (path, tableLength, minimumTableBase) => {
      const pathBytes = new TextEncoder().encode(path);
      const request = new Uint8Array(12 + pathBytes.length);
      const requestView = new DataView(request.buffer);
      requestView.setUint32(0, tableLength, true);
      requestView.setUint32(4, minimumTableBase, true);
      requestView.setUint32(8, pathBytes.length, true);
      request.set(pathBytes, 12);
      let result;
      for (let attempt = 0; attempt < 4096; attempt++) {
        result = relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_RESERVE, request, 12);
        if (result.rc !== -BigInt(EAGAIN)) break;
      }
      if (result?.rc !== 12n) return void 0;
      const responseView = new DataView(result.response.buffer, result.response.byteOffset, 12);
      return {
        generation: responseView.getUint32(0, true),
        tableBase: responseView.getUint32(4, true),
        existing: responseView.getUint32(8, true) !== 0
      };
    }, (path) => {
      relayRuntimeLinkCoordination(mailbox, pendingWake, METHOD.WORKER_RUNTIME_LINK_ABORT, new TextEncoder().encode(path), 0);
    }, (name, minimum) => reserveWorkerMainFunctionSlot(mailbox, pendingWake, name, minimum), `${msg.pid}:${msg.tid}`, workerBytesTransport(mailbox, pendingWake), (key2) => void relayStructuredSyscall(mailbox, pendingWake, METHOD.KERNEL_MODULE_CONSTRUCTED, constructedRequest(key2), 0));
    imports.env.sys_setrlimit = (resource, soft, hard) => workerSetRlimit(mailbox, pendingWake, resource, soft, hard);
    const releaseThreadStackForExit = () => {
      if (pendingThreadInstance) {
        releaseCurrentThreadStackForExit(pendingThreadInstance, msg.tid, () => imports.yurt[RUNTIME_LINK_OPS]?.abortPendingLoads());
      }
    };
    const resolvePendingThreadStackBounds = (startIndex) => resolvePthreadStartStackBounds((name) => instanceRef.value?.exports[name], startIndex);
    const abortReservedThreadStart = (fnPtr, startIndex) => abortReservedPthreadStartForCreate((name) => instanceRef.value?.exports[name], fnPtr, startIndex);
    const signalPolls = signalPollAnswererFor(mailbox);
    imports.yurt.syscall = (nr, a1, a2, a3, a4, a5, a6) => signalPolls.syscall(nr, a1, () => guestSyscall(mailbox, pendingWake, nr, a1, a2, a3, a4, a5, a6, relayStructuredSyscall, releaseThreadStackForExit, resolvePendingThreadStackBounds, abortReservedThreadStart));
    imports.yurt.syscall_fork_family = (nr, a1, a2, a3, a4, a5, a6) => guestForkFamily(mailbox, pendingWake, asyncifyBridge, msg.tid, nr, a1, a2, a3, a4, a5, a6);
    asyncifyBridge.setForkController(makeWorkerForkController(mailbox, pendingWake, true));
    const startupSymbols = /* @__PURE__ */ new Map();
    const startupGlobalStubs = installStartupGlobalImportStubs(imports, msg.startupGlobalImports);
    installStartupImportStubs(msg.module, imports, startupSymbols, msg.startupLinkPlan, void 0, true);
    instanceRef.value = new WebAssembly.Instance(msg.module, imports);
    const runtimeLinkOps = imports.yurt[RUNTIME_LINK_OPS];
    activeModuleOps = runtimeLinkOps?.moduleOps;
    activeInputReader = (id, length) => readRuntimeLinkInput((method, request, responseCap) => relayRuntimeLinkCoordination(mailbox, pendingWake, method, request, responseCap), id, length);
    pendingThreadAsyncify = runtimeLinkOps?.asyncify;
    for (const [name, value] of Object.entries(instanceRef.value.exports)) {
      if (!ASYNCIFY_EXPORTS.some((exportName) => exportName === name)) {
        startupSymbols.set(name, value);
      }
    }
    pendingStartupCtors = pendingStartupCtors.concat(loadStartupLinkPlan(msg.startupLinkPlan, msg.memory, instanceRef.value, startupSymbols, {
      reuseLayout: true,
      runConstructors: false,
      executionModules: pendingExecutionModules
    }));
    resolveStartupGlobalStubs(startupGlobalStubs, startupSymbols, msg.startupGlobalImports, instanceRef.value.exports.__indirect_function_table instanceof WebAssembly.Table ? instanceRef.value.exports.__indirect_function_table : void 0, "", dsoWeakImports(msg.module));
    if (runtimeLinkOps) {
      const rc = runtimeLinkOps.materialize();
      if (rc !== 0) throw new Error("runtime-link materialization failed");
    }
    pendingThreadInstance = instanceRef.value;
    pendingThreadMailbox = mailbox;
    pendingThreadPendingWake = pendingWake;
    pendingThreadMemory = msg.memory;
    pendingThreadArg = msg.arg;
    pendingThreadStackBounds = msg.stackBounds;
    pendingThreadTlsLayout = threadTlsLayout(instanceRef.value, msg.memory);
    asyncifyReady = false;
    Atomics.store(readyArr, 1, pendingThreadTlsLayout?.total ?? 0);
    Atomics.store(readyArr, 0, READY_OK);
    Atomics.notify(readyArr, 0);
  } catch {
    Atomics.store(readyArr, 0, READY_FAILED);
    Atomics.notify(readyArr, 0);
  } finally {
    leaveRuntimeLinkGuest(msg.runtimeLinkGateBuffer);
  }
}
function handleThreadRun() {
  const instance = pendingThreadInstance;
  const mailbox = pendingThreadMailbox;
  const pendingWake = pendingThreadPendingWake;
  if (!instance || !mailbox || !pendingWake) {
    reportTrap();
    return;
  }
  const reservation = new PthreadStartReservation((name) => instance.exports[name], pendingThreadArg >>> 0);
  if (activeRuntimeLinkGate) enterRuntimeLinkGuest(activeRuntimeLinkGate);
  try {
    runStartupConstructors(pendingStartupCtors, false);
    let shadowStackTop = pendingThreadStackBounds;
    if (shadowStackTop === void 0) {
      const resolved = resolvePthreadStartStackBounds((name) => instance.exports[name], pendingThreadArg >>> 0);
      if (resolved === 0) {
        reservation.release();
        reportTrap();
        return;
      }
      if (resolved !== void 0) shadowStackTop = resolved;
    }
    const memory = pendingThreadMemory;
    if (!memory) throw new Error("thread memory is unavailable");
    const stack = instance.exports.__stack_pointer;
    if (stack instanceof WebAssembly.Global && (shadowStackTop === void 0 || shadowStackTop.bottom >= shadowStackTop.top || shadowStackTop.top > memory.buffer.byteLength)) {
      reservation.release();
      throw new InvalidModuleExecutionState("invalid pthread stack bounds");
    }
    pendingThreadStackBounds = shadowStackTop;
    if (shadowStackTop !== void 0) {
      enterThreadStack(memory, mainExecutionBindings(instance, memory, pendingExecutionModules, shadowStackTop));
    }
    const threadMapping = initThreadTls(pendingThreadTlsLayout, memory);
    if (threadMapping?.asyncify) {
      asyncifyReady = initAsyncifyBridge(asyncifyBridge, instance, memory, threadMapping.asyncify, mainExecutionBindings(instance, memory, pendingExecutionModules, pendingThreadStackBounds), pendingThreadAsyncify);
    }
    const entry = instance.exports.yurt_pthread_start_trampoline;
    if (typeof entry !== "function") {
      reservation.release();
      reportTrap();
      return;
    }
    const threadEntry = entry;
    const driven = asyncifyReady ? asyncifyBridge.wrapExportSyncDrive(threadEntry) : threadEntry;
    const finishStart = instance.exports.yurt_pthread_finish_start;
    const table = instance.exports.__indirect_function_table;
    pthreadStartHandoffArmed = asyncifyReady && typeof finishStart === "function" && table instanceof WebAssembly.Table;
    reservation.consume();
    const retval = drivePthreadStart(() => Number(driven(pendingThreadArg >>> 0)) | 0, table, finishStart);
    reportThreadExit(retval);
  } catch (err) {
    reservation.release();
    if (err instanceof GuestProcessExited) {
      reportExit(err.code);
      return;
    }
    if (err instanceof GuestThreadExited) {
      reportThreadExit(err.code);
      return;
    }
    reportTrap(err);
  } finally {
    if (activeRuntimeLinkGate) leaveRuntimeLinkGuest(activeRuntimeLinkGate);
  }
}
function drivePthreadStart(enterTrampoline, table, finishStart) {
  let handoff;
  let retval;
  try {
    retval = enterTrampoline();
  } catch (error) {
    if (!(error instanceof PthreadStartHandoff)) throw error;
    handoff = error;
  }
  if (handoff === void 0) {
    pthreadStartHandoffArmed = false;
    return retval;
  }
  for (let handoffs = 1; handoff !== void 0; handoffs++) {
    if (handoffs >= 2) pthreadStartHandoffArmed = false;
    const routine = table.get(handoff.fnPtr);
    if (typeof routine !== "function") {
      throw new Error(`pthread start routine ${handoff.fnPtr} is not a function`);
    }
    const arg = handoff.arg;
    handoff = void 0;
    try {
      retval = Number(asyncifyBridge.wrapExportSyncDrive(routine)(arg)) | 0;
    } catch (error) {
      if (!(error instanceof PthreadStartHandoff)) throw error;
      handoff = error;
    }
  }
  pthreadStartHandoffArmed = false;
  finishStart(retval);
  return retval;
}
function threadTlsLayout(instance, memory) {
  const plan = threadTlsPlan(memory, mainExecutionBindings(instance, memory, pendingExecutionModules, pendingThreadStackBounds));
  const tlsSize = plan.size;
  const asyncifySize = threadAsyncifyBufSize(instance, memory);
  if (tlsSize === 0 && asyncifySize === 0) return void 0;
  const { total, asyncifyOffset } = threadTlsMappingSize(tlsSize, asyncifySize);
  return {
    plan,
    total,
    asyncifyOffset,
    asyncifySize
  };
}
function initThreadTls(layout, memory) {
  if (!layout) return void 0;
  const mapping = activeCompletion && readThreadAdmission(activeCompletion);
  if (!mapping || mapping.len !== layout.total) {
    throw new Error("thread TLS block was not mapped by the coordinator");
  }
  initializeThreadTlsPlan(layout.plan, mapping.addr, mapping.len, memory);
  return {
    addr: mapping.addr,
    len: mapping.len,
    asyncify: layout.asyncifySize > 0 ? {
      dataAddr: mapping.addr + layout.asyncifyOffset,
      dataSize: layout.asyncifySize
    } : void 0
  };
}
function threadAsyncifyBufSize(instance, memory) {
  const exports = instance.exports;
  if (typeof exports.asyncify_start_unwind !== "function") return 0;
  const sizeGlobal = exports.yurt_asyncify_buf_size;
  if (!(sizeGlobal instanceof WebAssembly.Global) || typeof sizeGlobal.value !== "number") return 0;
  const size = new DataView(memory.buffer).getUint32(sizeGlobal.value, true);
  return size >= 8 ? size : 0;
}
function parkWithPendingWakeInterlock(mailbox, pendingWake, timeoutMs) {
  publishParkRequested(mailbox);
  const committed = commitParkedOrDetectWake(mailbox, pendingWake);
  if (committed === "woken-immediately") return committed;
  const result = guestWait(mailbox.control, 0, committed.word, timeoutMs);
  return result === "timed-out" ? "timed-out" : "woken-after-wait";
}
function publishParkRequested(mailbox) {
  transitionMailbox(mailbox, "PARK_REQUESTED");
}
function commitParkedOrDetectWake(mailbox, pendingWake) {
  if (takePendingWake(pendingWake)) {
    publishWake(mailbox);
    return "woken-immediately";
  }
  const word = mailbox.controlWord;
  const generation = Math.floor(word / 16);
  if (word !== packControlWord("PARK_REQUESTED", generation)) {
    return "woken-immediately";
  }
  const waitParkedWord = packControlWord("WAIT_PARKED", generation + 1);
  if (Atomics.compareExchange(mailbox.control, 0, word, waitParkedWord) !== word) {
    return "woken-immediately";
  }
  return {
    word: waitParkedWord
  };
}

// src/page_worker_bridge.ts
var GUEST_WORKER_PORT = "yurt-guest-worker-port";
function adoptGuestPort(scope) {
  const bootstrap = scope.onmessage;
  scope.onmessage = (event) => {
    const port = event.ports[0];
    if (port === void 0 || event.data?.type !== GUEST_WORKER_PORT) {
      return;
    }
    scope.onmessage = null;
    scope.postMessage = (message, transfer) => port.postMessage(message, transfer ?? []);
    port.onmessage = (portEvent) => bootstrap?.(portEvent);
  };
}

// src/guest_worker_entry.ts
adoptGuestPort(self);
/*!
 * hash-wasm (https://www.npmjs.com/package/hash-wasm)
 * (c) Dani Biro
 * @license MIT
 */
