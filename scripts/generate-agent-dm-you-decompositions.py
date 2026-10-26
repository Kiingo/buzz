#!/usr/bin/env python3
"""Regenerate mobile/lib/shared/agent_dm/agent_dm_you_decompositions.dart.

Every code point above U+007F whose NFKD form, with combining marks (Mn, Me)
removed and the look-alike table applied, is a single y, o or u. LOOKALIKES
must match _youLookalikes in agent_dm_mirror_display.dart (and desktop's
YOU_LOOKALIKES, iOS youLookalikes). The entry count is pinned in
mobile/test/shared/agent_dm/agent_dm_mirror_display_test.dart, so a Unicode
version change that moves it fails there.

Usage: scripts/generate-agent-dm-you-decompositions.py > \\
  mobile/lib/shared/agent_dm/agent_dm_you_decompositions.dart
"""

import unicodedata

LOOKALIKES = {
    0x0423: "y", 0x0443: "y", 0x04AE: "y", 0x04AF: "y", 0x03A5: "y", 0x028F: "y",
    0x13A9: "y", 0x041E: "o", 0x043E: "o", 0x039F: "o", 0x03BF: "o", 0x0555: "o",
    0x0585: "o", 0x1D0F: "o", 0x30: "o", 0x03C5: "u", 0x054D: "u", 0x057D: "u",
    0x1D1C: "u", 0x028B: "u",
}


def fold(text):
    decomposed = unicodedata.normalize("NFKD", text)
    bare = "".join(c for c in decomposed if unicodedata.category(c) not in ("Mn", "Me"))
    return "".join(LOOKALIKES.get(ord(c), c) for c in bare)


def main():
    table = {}
    for code in range(0x80, 0x110000):
        if 0xD800 <= code <= 0xDFFF or code in LOOKALIKES:
            continue
        folded = fold(chr(code))
        if len(folded) == 1 and folded.lower() in ("y", "o", "u"):
            table[code] = folded.lower()
    print("/// Generated: every code point above U+007F whose NFKD form, with combining")
    print("/// marks (Mn, Me) removed and the look-alike table applied, is a single y, o")
    print("/// or u (Python unicodedata, Unicode %s). It stands in for NFKD in" % unicodedata.unidata_version)
    print("/// [agentDmNameReadsAsYou], since this app has no Unicode normaliser:")
    print("/// precomposed letters (ó U+00F3, ý, ÿ, Latin Extended-A and beyond),")
    print("/// fullwidth, circled, modifier and mathematical forms.")
    print("library;")
    print()
    print("const agentDmYouDecompositions = <int, int>{")
    for code in sorted(table):
        print("  0x%04x: 0x%02x," % (code, ord(table[code])))
    print("};")


if __name__ == "__main__":
    main()
