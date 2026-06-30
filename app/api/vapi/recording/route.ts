import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const callId = searchParams.get("callId");

    if (!callId) {
      return NextResponse.json({ error: "callId required" }, { status: 400 });
    }

    const apiKey = process.env.VAPI_API_KEY;

    if (!apiKey) {
      return NextResponse.json({ error: "VAPI_API_KEY missing" }, { status: 500 });
    }

    const vapiRes = await fetch(
      `https://api.vapi.ai/call/${callId}/mono-recording`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        redirect: "follow",
        cache: "no-store",
      }
    );

    if (!vapiRes.ok) {
      const text = await vapiRes.text().catch(() => "");
      return NextResponse.json(
        {
          error: "Failed to fetch recording from Vapi",
          status: vapiRes.status,
          body: text,
        },
        { status: 502 }
      );
    }

    const contentType =
      vapiRes.headers.get("content-type") || "audio/wav";

    const arrayBuffer = await vapiRes.arrayBuffer();

    return new NextResponse(Buffer.from(arrayBuffer), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "server error" },
      { status: 500 }
    );
  }
}
