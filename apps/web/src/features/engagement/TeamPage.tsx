import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { useSurveys } from './engagement.api';
import { ResultsView } from './ResultsView';

/** The manager's view: team aggregate only. Nothing here names a respondent or shows a comment. */
export function TeamEngagementPage() {
  const surveys = useSurveys({ page: 1, pageSize: 50 });
  const list = (surveys.data?.data ?? []).filter((s) => s.status === 'OPEN' || s.status === 'CLOSED');
  const [id, setId] = useState('');
  const selected = id || list[0]?.id || '';
  const survey = list.find((s) => s.id === selected);
  return (
    <div className="space-y-4">
      <Card><div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2"><Select label="Survey" options={list.map((s) => ({ value: s.id, label: `${s.name} · ${s.status.toLowerCase()}` }))} placeholder="No surveys yet" value={selected} onChange={(e) => setId(e.target.value)} /><p className="self-end text-xs text-slate-500">Your team's aggregate: response rate, question and theme results, eNPS when the group meets the survey's threshold. Individual answers and comments are never shown here.</p></div></Card>
      {surveys.isError && <Alert>Could not load surveys.</Alert>}
      {survey && <ResultsView surveyId={survey.id} code={survey.code} allowFilters={false} allowCsv={false} />}
    </div>
  );
}
