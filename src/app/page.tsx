'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  ShieldCheck, Scale, Vault, ScrollText, ArrowRight, Play,
  AlertTriangle, CheckCircle2, Copy, Check, FileCode2,
  Users, Clock, Lock, Zap, ChevronRight, Download, Layers,
  Settings, Eye, Code2, BookOpen
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EXAMPLE_POLICY, OZ_CONTRACTS, type CompilationResult } from '@/lib/policy-types';
import type { CompiledContract } from '@/lib/policy-types';

function highlightSolidity(code: string): string {
  return code
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(\/\/[^\n]*)/g, '<span class="sol-comment">$1</span>')
    .replace(/\b(pragma|solidity|import|contract|is|function|external|internal|public|view|pure|override|returns|return|require|emit|event|error|modifier|struct|enum|mapping|constructor|if|else|for|while|memory|storage|calldata|payable|virtual)\b/g, '<span class="sol-keyword">$1</span>')
    .replace(/\b(uint256|uint8|address|bool|string|bytes32|bytes|bytes\[\]|int256)\b/g, '<span class="sol-type">$1</span>')
    .replace(/\b(\d+)\b/g, '<span class="sol-number">$1</span>')
    .replace(/"[^"]*"/g, '<span class="sol-string">$&</span>')
    .split('\n')
    .map(line => `<span class="line">${line}</span>`)
    .join('\n');
}

// API route for compilation
async function compilePolicyServer(yaml: string): Promise<CompilationResult> {
  const res = await fetch('/api/compile?XTransformPort=3000', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml }),
  });
  return res.json();
}

export default function Home() {
  const [policyYaml, setPolicyYaml] = useState(EXAMPLE_POLICY);
  const [result, setResult] = useState<CompilationResult | null>(null);
  const [activeContract, setActiveContract] = useState(0);
  const [activeTab, setActiveTab] = useState('editor');
  const [copied, setCopied] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [lineCount, setLineCount] = useState(0);

  useEffect(() => {
    setLineCount(policyYaml.split('\n').length);
  }, [policyYaml]);

  const handleCompile = useCallback(async () => {
    setCompiling(true);
    try {
      const res = await compilePolicyServer(policyYaml);
      setResult(res);
      setActiveContract(0);
      setActiveTab('contracts');
    } catch {
      setResult({
        contracts: [],
        deployment_order: [],
        total_lines: 0,
        errors: ['Compilation server error — check your policy YAML syntax'],
        warnings: [],
        oz_contracts_used: [],
      });
    } finally {
      setCompiling(false);
    }
  }, [policyYaml]);

  const copyToClipboard = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const downloadContract = useCallback((contract: CompiledContract) => {
    const blob = new Blob([contract.solidity], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${contract.name}.sol`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const downloadAll = useCallback(() => {
    if (!result) return;
    const all = result.contracts.map(c => `// ${'='.repeat(60)}\n// ${c.name}.sol\n// ${c.description}\n// ${'='.repeat(60)}\n\n${c.solidity}`).join('\n\n');
    const blob = new Blob([all], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'governance-contracts.sol';
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  const ozUsed = useMemo(() => {
    if (!result) return [];
    return result.oz_contracts_used.map(k => ({
      key: k,
      ...(OZ_CONTRACTS as any)[k] || { name: k, description: '', category: 'Other' }
    }));
  }, [result]);

  // Lightweight YAML-like parser for sidebar preview (no dependency needed)
  const policy = useMemo(() => {
    try {
      const lines = policyYaml.split('\n');
      const obj: Record<string, any> = {};
      let currentSection = '';
      let currentArray: any[] = [];
      let currentObj: Record<string, any> = {};

      for (const raw of lines) {
        const line = raw.replace(/\t/g, '  ');
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        if (line.match(/^[\w]/) && !line.startsWith(' ') && trimmed.includes(':')) {
          if (currentSection && currentArray.length > 0) {
            obj[currentSection] = currentArray;
            currentArray = [];
            currentObj = {};
          } else if (currentSection) {
            obj[currentSection] = currentObj;
            currentObj = {};
          }
          const [key, ...rest] = trimmed.split(':');
          const val = rest.join(':').trim();
          if (val === '') {
            currentSection = key;
            currentObj = {};
          } else {
            obj[key] = val.replace(/^["']|["']$/g, '');
            currentSection = '';
          }
        } else if (line.startsWith('  - ') && currentSection) {
          if (Object.keys(currentObj).length > 0) {
            currentArray.push(currentObj);
            currentObj = {};
          }
          const [key, ...rest] = trimmed.split(':');
          const val = rest.join(':').trim();
          currentObj[key] = val.replace(/^["']|["']$/g, '');
        } else if (line.match(/^    \w/) && currentSection) {
          const [key, ...rest] = trimmed.split(':');
          const val = rest.join(':').trim();
          if (val.startsWith('[')) {
            currentObj[key] = val.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, ''));
          } else {
            currentObj[key] = val.replace(/^["']|["']$/g, '');
          }
        } else if (line.match(/^    - /) && currentObj) {
          const k = Object.keys(currentObj).find(k => Array.isArray(currentObj[k]));
          if (k) {
            currentObj[k].push(trimmed.slice(2).replace(/^["']|["']$/g, ''));
          }
        }
      }
      if (currentSection && currentArray.length > 0) {
        obj[currentSection] = currentArray;
      } else if (currentSection && Object.keys(currentObj).length > 0) {
        obj[currentSection] = currentArray.length > 0 ? [...currentArray, currentObj] : currentObj;
      }
      return obj;
    } catch { return null; }
  }, [policyYaml]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-none">PolicyForge</h1>
              <p className="text-[11px] text-muted-foreground mt-0.5">OpenZeppelin Governance-as-Code</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[11px] gap-1 border-primary/30 text-primary">
              <Layers className="w-3 h-3" />
              {result ? `${result.oz_contracts_used.length} OZ Contracts` : 'Ready'}
            </Badge>
            <Badge variant="outline" className="text-[11px] gap-1">
              <Code2 className="w-3 h-3" />
              Solidity ^0.8.20
            </Badge>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-[1600px] mx-auto w-full px-4 sm:px-6 py-4">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="bg-card border border-border w-full sm:w-auto">
            <TabsTrigger value="editor" className="gap-1.5 text-xs">
              <ScrollText className="w-3.5 h-3.5" /> Policy Editor
            </TabsTrigger>
            <TabsTrigger value="contracts" className="gap-1.5 text-xs" disabled={!result || result.errors.length > 0}>
              <FileCode2 className="w-3.5 h-3.5" /> Generated Contracts
              {result && result.errors.length === 0 && (
                <Badge className="ml-1 bg-primary text-[10px] px-1.5 py-0 h-4">{result.contracts.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="architecture" className="gap-1.5 text-xs" disabled={!result || result.errors.length > 0}>
              <BookOpen className="w-3.5 h-3.5" /> Architecture
            </TabsTrigger>
          </TabsList>

          {/* EDITOR TAB */}
          <TabsContent value="editor" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* YAML Editor */}
              <div className="lg:col-span-2">
                <Card className="border-border">
                  <CardHeader className="pb-3 px-4 pt-4">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-medium flex items-center gap-2">
                        <Settings className="w-4 h-4 text-primary" />
                        Governance Policy
                        <span className="text-[11px] text-muted-foreground font-normal">YAML</span>
                      </CardTitle>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">{lineCount} lines</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-[11px] h-7"
                          onClick={() => { setPolicyYaml(EXAMPLE_POLICY); setResult(null); }}
                        >
                          Reset Example
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0 relative">
                    <div className="flex">
                      <div className="flex-shrink-0 py-3 px-2 text-right select-none border-r border-border">
                        {Array.from({ length: lineCount }, (_, i) => (
                          <div key={i} className="text-[11px] leading-[1.6] text-muted-foreground/50 font-mono">
                            {i + 1}
                          </div>
                        ))}
                      </div>
                      <textarea
                        ref={editorRef}
                        value={policyYaml}
                        onChange={(e) => { setPolicyYaml(e.target.value); setResult(null); }}
                        className="policy-editor flex-1 p-3 min-h-[500px] lg:min-h-[600px] w-full"
                        spellCheck={false}
                      />
                    </div>
                  </CardContent>
                  <div className="border-t border-border px-4 py-3 flex items-center justify-between">
                    <div className="text-[11px] text-muted-foreground">
                      Define roles, treasury tiers, voting rules, and timelock config in YAML
                    </div>
                    <Button
                      onClick={handleCompile}
                      disabled={compiling}
                      className="gap-1.5 text-xs h-8 bg-primary hover:bg-primary/90"
                    >
                      {compiling ? (
                        <div className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                      ) : (
                        <Play className="w-3.5 h-3.5" />
                      )}
                      Compile to OZ Contracts
                    </Button>
                  </div>
                </Card>
              </div>

              {/* Sidebar - Policy Summary + OZ Overview */}
              <div className="space-y-4">
                {/* Quick Stats */}
                {policy && (
                  <Card className="border-border">
                    <CardHeader className="pb-3 px-4 pt-4">
                      <CardTitle className="text-sm font-medium flex items-center gap-2">
                        <Eye className="w-4 h-4 text-accent" />
                        Policy Preview
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4 space-y-3">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Name</span>
                          <span className="font-medium">{policy.name || '—'}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Version</span>
                          <Badge variant="outline" className="text-[10px]">v{policy.version || '—'}</Badge>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Network</span>
                          <span className="font-mono text-[11px]">{policy.network || '—'}</span>
                        </div>
                      </div>

                      <div className="border-t border-border pt-3 space-y-2">
                        <div className="flex items-center gap-2 text-xs">
                          <Users className="w-3.5 h-3.5 text-blue-400" />
                          <span>{policy.roles?.length || 0} roles defined</span>
                        </div>
                        {policy.roles?.slice(0, 3).map((r: any) => (
                          <div key={r.name} className="ml-5.5 flex items-center justify-between text-[11px]">
                            <span className="text-muted-foreground">{r.name}</span>
                            <span className="text-muted-foreground">{r.members?.length || 0} members</span>
                          </div>
                        ))}
                        {(policy.roles?.length || 0) > 3 && (
                          <div className="ml-5.5 text-[11px] text-muted-foreground">
                            +{(policy.roles?.length || 0) - 3} more...
                          </div>
                        )}
                      </div>

                      <div className="border-t border-border pt-3 space-y-2">
                        <div className="flex items-center gap-2 text-xs">
                          <Vault className="w-3.5 h-3.5 text-amber-400" />
                          <span>{policy.treasury?.limits?.length || 0} treasury tiers</span>
                        </div>
                        {policy.treasury?.limits?.map((l: any, i: number) => (
                          <div key={i} className="ml-5.5 text-[11px] text-muted-foreground">
                            Tier {i + 1}: {l.amount} {l.currency}/{l.period} — [{l.requires?.join(', ')}]
                          </div>
                        ))}
                      </div>

                      <div className="border-t border-border pt-3 space-y-2">
                        <div className="flex items-center gap-2 text-xs">
                          <Scale className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Quorum: {policy.proposals?.quorum_percentage || 0}%</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <Clock className="w-3.5 h-3.5 text-violet-400" />
                          <span>Timelock: {policy.timelock?.min_delay || '—'}</span>
                        </div>
                        {policy.emergency?.pause_enabled && (
                          <div className="flex items-center gap-2 text-xs">
                            <Lock className="w-3.5 h-3.5 text-red-400" />
                            <span>Emergency pause: {policy.emergency.pause_role}</span>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* OZ Contracts Used */}
                <Card className="border-border">
                  <CardHeader className="pb-3 px-4 pt-4">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Layers className="w-4 h-4 text-primary" />
                      OpenZeppelin Contracts
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4 space-y-2">
                    {result ? (
                      <>
                        <div className="text-[11px] text-muted-foreground mb-2">
                          {result.oz_contracts_used.length} contracts will be imported:
                        </div>
                        {ozUsed.map((c) => (
                          <div key={c.key} className="flex items-start gap-2 p-2 rounded-md bg-secondary/50">
                            <CheckCircle2 className="w-3.5 h-3.5 text-primary mt-0.5 flex-shrink-0" />
                            <div>
                              <div className="text-[11px] font-medium">{c.name}</div>
                              <div className="text-[10px] text-muted-foreground">{c.description}</div>
                            </div>
                          </div>
                        ))}
                      </>
                    ) : (
                      <div className="text-[11px] text-muted-foreground text-center py-4">
                        Compile your policy to see which OZ contracts are used
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Errors / Warnings */}
                {result && (result.errors.length > 0 || result.warnings.length > 0) && (
                  <Card className="border-border">
                    <CardContent className="px-4 py-3 space-y-2">
                      {result.errors.map((e, i) => (
                        <div key={i} className="flex items-start gap-2 text-[11px] text-red-400">
                          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <span>{e}</span>
                        </div>
                      ))}
                      {result.warnings.map((w, i) => (
                        <div key={i} className="flex items-start gap-2 text-[11px] text-amber-400">
                          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <span>{w}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </TabsContent>

          {/* CONTRACTS TAB */}
          <TabsContent value="contracts" className="space-y-4">
            {result && result.errors.length === 0 && (
              <>
                {/* Summary Bar */}
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-primary" />
                    <span className="font-medium">{result.contracts.length} contracts generated</span>
                    <span className="text-muted-foreground text-xs">({result.total_lines} lines)</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs gap-1.5 ml-auto"
                    onClick={downloadAll}
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download All
                  </Button>
                </div>

                {/* Deployment Order */}
                <Card className="border-border">
                  <CardHeader className="pb-3 px-4 pt-4">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Zap className="w-4 h-4 text-accent" />
                      Deployment Order
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {result.deployment_order.map((name, i) => (
                        <div key={name} className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="cursor-pointer text-xs hover:border-primary hover:text-primary transition-colors"
                            onClick={() => setActiveContract(i)}
                          >
                            {i + 1}. {name}
                          </Badge>
                          {i < result.deployment_order.length - 1 && (
                            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Contract Tabs + Code */}
                <Card className="border-border overflow-hidden">
                  <div className="border-b border-border flex flex-wrap">
                    {result.contracts.map((c, i) => (
                      <button
                        key={c.name}
                        onClick={() => setActiveContract(i)}
                        className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                          activeContract === i
                            ? 'border-primary text-primary'
                            : 'border-transparent text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {c.name}.sol
                      </button>
                    ))}
                  </div>
                  {result.contracts[activeContract] && (
                    <div className="relative">
                      <div className="absolute top-2 right-2 z-10 flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-[11px] bg-card/80 backdrop-blur"
                          onClick={() => copyToClipboard(
                            result.contracts[activeContract].solidity,
                            result.contracts[activeContract].name
                          )}
                        >
                          {copied === result.contracts[activeContract].name ? (
                            <Check className="w-3 h-3" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-[11px] bg-card/80 backdrop-blur"
                          onClick={() => downloadContract(result.contracts[activeContract])}
                        >
                          <Download className="w-3 h-3" />
                        </Button>
                      </div>
                      <div className="overflow-auto max-h-[600px] custom-scroll">
                        <pre className="code-block p-4">
                          <code
                            dangerouslySetInnerHTML={{
                              __html: highlightSolidity(result.contracts[activeContract].solidity),
                            }}
                          />
                        </pre>
                      </div>
                    </div>
                  )}
                </Card>
              </>
            )}
          </TabsContent>

          {/* ARCHITECTURE TAB */}
          <TabsContent value="architecture" className="space-y-4">
            {result && result.errors.length === 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* System Diagram */}
                <Card className="border-border">
                  <CardHeader className="pb-3 px-4 pt-4">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-primary" />
                      Contract Architecture
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="space-y-3 text-xs">
                      {result.contracts.map((c, i) => (
                        <div key={`${c.name}-${i}`} className="p-3 rounded-lg bg-secondary/50 border border-border">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              <div className="w-5 h-5 rounded bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary">
                                {i + 1}
                              </div>
                              <span className="font-medium font-mono">{c.name}</span>
                            </div>
                            <Badge variant="outline" className="text-[10px]">
                              {c.solidity.split('\n').length} lines
                            </Badge>
                          </div>
                          <p className="text-muted-foreground text-[11px] mb-2">{c.description}</p>
                          <div className="flex flex-wrap gap-1">
                            {c.inherits.map((inh, j) => (
                              <Badge key={`${inh}-${j}`} variant="secondary" className="text-[10px] bg-primary/5 text-primary border-primary/20">
                                OZ.{inh}
                              </Badge>
                            ))}
                          </div>
                          {i < result.contracts.length - 1 && (
                            <div key={`arrow-${i}`} className="flex justify-center mt-2">
                              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* OZ Dependency Graph */}
                <Card className="border-border">
                  <CardHeader className="pb-3 px-4 pt-4">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Layers className="w-4 h-4 text-accent" />
                      OpenZeppelin Dependency Map
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4 space-y-3">
                    {['Governance', 'Security', 'Tokens', 'Utility'].filter((cat) => ozUsed.some((c) => (c as any).category === cat)).map((cat) => {
                      const contracts = ozUsed.filter((c) => (c as any).category === cat);
                      return (
                        <div key={cat}>
                          <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                            {cat}
                          </div>
                          <div className="space-y-1">
                            {contracts.map((c) => (
                              <div key={c.key} className="flex items-center gap-2 p-2 rounded-md bg-secondary/30 text-xs">
                                <div className={`w-2 h-2 rounded-full ${
                                  cat === 'Governance' ? 'bg-emerald-400' :
                                  cat === 'Security' ? 'bg-red-400' :
                                  cat === 'Tokens' ? 'bg-blue-400' :
                                  'bg-amber-400'
                                }`} />
                                <span className="font-mono font-medium">{c.key}</span>
                                <span className="text-muted-foreground text-[11px] truncate">
                                  — {(c as any).description}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    <div className="border-t border-border pt-3">
                      <div className="text-[11px] text-muted-foreground">
                        Total: <span className="text-foreground font-medium">{result.oz_contracts_used.length}</span> OpenZeppelin contracts imported across{' '}
                        <span className="text-foreground font-medium">{result.contracts.length}</span> generated files
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1">
                        All contracts inherit from audited, battle-tested OZ primitives
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* How It Works */}
                <Card className="border-border lg:col-span-2">
                  <CardHeader className="pb-3 px-4 pt-4">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Zap className="w-4 h-4 text-primary" />
                      How PolicyForge Works
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      {[
                        { icon: ScrollText, label: 'Define', desc: 'Write governance rules as YAML — roles, treasury tiers, voting config, timelock settings', color: 'text-blue-400' },
                        { icon: Code2, label: 'Compile', desc: 'Policy engine validates and compiles YAML into production-ready Solidity contracts', color: 'text-primary' },
                        { icon: Layers, label: 'Compose', desc: 'Each contract inherits audited OpenZeppelin primitives — Governor, AccessControl, TimelockController', color: 'text-accent' },
                        { icon: Zap, label: 'Deploy', desc: 'Deploy in dependency order with constructor wiring — token, timelock, governor, treasury', color: 'text-red-400' },
                      ].map(({ icon: Icon, label, desc, color }) => (
                        <div key={label} className="p-3 rounded-lg border border-border bg-secondary/20">
                          <Icon className={`w-5 h-5 ${color} mb-2`} />
                          <div className="text-sm font-medium mb-1">{label}</div>
                          <div className="text-[11px] text-muted-foreground leading-relaxed">{desc}</div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-auto">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>PolicyForge — Governance-as-Code with OpenZeppelin</span>
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="w-3 h-3" />
            Contracts inherit audited OZ primitives
          </span>
        </div>
      </footer>
    </div>
  );
}