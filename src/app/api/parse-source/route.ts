import { NextResponse } from "next/server";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No file provided." },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: "File exceeds 10 MB limit." },
        { status: 400 }
      );
    }

    const name = file.name || "uploaded-source";
    const lower = name.toLowerCase();

    if (lower.endsWith(".txt") || file.type === "text/plain") {
      const text = (await file.text()).trim();
      if (!text) {
        return NextResponse.json(
          { error: "The uploaded TXT file is empty." },
          { status: 400 }
        );
      }
      return NextResponse.json({
        title: name,
        type: "txt",
        content: text,
        charCount: text.length,
      });
    }

    if (lower.endsWith(".pdf") || file.type === "application/pdf") {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      try {
        const pdfParseModule = await import("pdf-parse");
        const pdfParse = pdfParseModule.default;
        const parsed = await pdfParse(buffer);
        const text = (parsed.text || "").replace(/\s+\n/g, "\n").trim();

        if (!text) {
          return NextResponse.json(
            {
              error:
                "Could not extract readable text from this PDF (it may be scanned or image-only).",
            },
            { status: 400 }
          );
        }

        return NextResponse.json({
          title: name,
          type: "pdf",
          content: text,
          charCount: text.length,
        });
      } catch (pdfErr) {
        // pdf-parse throws for corrupt/invalid PDF structure (e.g., bad XRef entry)
        // This is a client-supplied file error, not a server error — return 400
        const msg =
          pdfErr instanceof Error ? pdfErr.message : "Invalid PDF structure";
        return NextResponse.json(
          {
            error: `Could not parse PDF: ${msg}. The file may be corrupt, password-protected, or not a valid PDF.`,
          },
          { status: 400 }
        );
      }
    }

    return NextResponse.json(
      { error: "Unsupported file type. Upload a .pdf or .txt file." },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to parse uploaded file.",
      },
      { status: 500 }
    );
  }
}
