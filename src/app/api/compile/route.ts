import { NextRequest, NextResponse } from 'next/server';
import { compilePolicy } from '@/lib/policy-compiler';

export async function POST(req: NextRequest) {
  try {
    const { yaml } = await req.json();

    if (!yaml || typeof yaml !== 'string') {
      return NextResponse.json(
        { contracts: [], deployment_order: [], total_lines: 0, errors: ['No YAML provided'], warnings: [], oz_contracts_used: [] },
        { status: 400 }
      );
    }

    const result = compilePolicy(yaml);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { contracts: [], deployment_order: [], total_lines: 0, errors: [error.message || 'Internal server error'], warnings: [], oz_contracts_used: [] },
      { status: 500 }
    );
  }
}