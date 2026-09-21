import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TreeNode {
  id: string;
  label: ReactNode;
  /** Secondary text / badges shown after the label. */
  meta?: ReactNode;
  /** Right-aligned actions (buttons) for this node. */
  actions?: ReactNode;
  children?: TreeNode[];
  /** Non-collapsible leaf styling (e.g. a position under a department). */
  leaf?: boolean;
  muted?: boolean;
}

interface TreeViewProps {
  nodes: TreeNode[];
  /** Ids expanded initially; defaults to everything. */
  defaultExpanded?: 'all' | Set<string>;
}

/** Lightweight recursive tree with expand/collapse. Purely presentational. */
export function TreeView({ nodes, defaultExpanded = 'all' }: TreeViewProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => (defaultExpanded === 'all' ? new Set() : new Set(allIds(nodes).filter((id) => !defaultExpanded.has(id)))));
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <ul className="space-y-0.5">
      {nodes.map((n) => (
        <TreeItem key={n.id} node={n} depth={0} collapsed={collapsed} toggle={toggle} />
      ))}
    </ul>
  );
}

function allIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...allIds(n.children ?? [])]);
}

function TreeItem({ node, depth, collapsed, toggle }: { node: TreeNode; depth: number; collapsed: Set<string>; toggle: (id: string) => void }) {
  const hasChildren = !!node.children?.length;
  const open = !collapsed.has(node.id);
  return (
    <li>
      <div className={cn('group flex items-center gap-1.5 rounded-md py-1.5 pr-2 hover:bg-slate-50', node.muted && 'opacity-60')} style={{ paddingLeft: `${depth * 20 + 8}px` }}>
        {node.leaf ? (
          <span className="w-5 shrink-0 text-center text-slate-300">·</span>
        ) : (
          <button
            onClick={() => toggle(node.id)}
            disabled={!hasChildren}
            className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-200', !hasChildren && 'invisible')}
            aria-label={open ? 'Collapse' : 'Expand'}
            aria-expanded={open}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className={cn('truncate', node.leaf ? 'text-slate-700' : 'font-medium text-slate-900')}>{node.label}</span>
          {node.meta}
        </div>
        {node.actions && <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{node.actions}</div>}
      </div>
      {hasChildren && open && (
        <ul>
          {node.children!.map((c) => (
            <TreeItem key={c.id} node={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} />
          ))}
        </ul>
      )}
    </li>
  );
}
