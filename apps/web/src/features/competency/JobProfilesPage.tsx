import { useEffect, useState } from 'react';
import type { JobRequirementDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useJobOptions } from '@/features/organization/organization.api';
import { errorMessage } from '@/features/organization/shared';
import { useCompetencies, useCompetencyMutations, useJobProfile } from './competency.api';

/**
 * What each job asks for.
 *
 * Requirements live on the **job** because a position already names one, so the chain from a person to what is
 * expected of them is `employee → position → job → requirements`. Changing a requirement changes what is expected
 * from now on; it never rewrites an assessment that has already been made.
 */
export function JobProfilesPage() {
  const jobs = useJobOptions();
  const [jobId, setJobId] = useState('');
  const profile = useJobProfile(jobId || null);
  const competencies = useCompetencies({ status: 'active', pageSize: 100 });
  const m = useCompetencyMutations();
  const toast = useToast();
  const [competencyId, setCompetencyId] = useState('');
  const [requiredLevel, setRequiredLevel] = useState('');
  const [weight, setWeight] = useState('');
  const [isMandatory, setIsMandatory] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId && jobs.data?.data.length) setJobId(jobs.data.data[0].id);
  }, [jobs.data, jobId]);

  const chosen = (competencies.data?.data ?? []).find((c) => c.id === competencyId);

  const add = async () => {
    setErr(null);
    try {
      await m.setRequirement.mutateAsync({
        jobId,
        input: { competencyId, requiredLevel: Number(requiredLevel), weight: weight === '' ? null : Number(weight), isMandatory },
      });
      toast.success('Requirement saved');
      setCompetencyId(''); setRequiredLevel(''); setWeight('');
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const remove = async (requirement: JobRequirementDto) => {
    setErr(null);
    try { await m.removeRequirement.mutateAsync({ jobId, competencyId: requirement.competency.id }); } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-4">
          <Select
            label="Job"
            options={(jobs.data?.data ?? []).map((j) => ({ value: j.id, label: `${j.title} (${j.code})` }))}
            placeholder="Choose a job"
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            className="max-w-md"
          />
        </div>
      </Card>

      {profile.isLoading && jobId && <LoadingBlock />}
      {err && <Alert>{err}</Alert>}

      {profile.data && (
        <>
          <Card>
            <CardHeader
              title={`${profile.data.job.title} — competency profile`}
              description={`${profile.data.requirements.length} competenc${profile.data.requirements.length === 1 ? 'y' : 'ies'} · ${profile.data.employeeCount} employee${profile.data.employeeCount === 1 ? '' : 's'} in this job`}
            />
            {profile.data.requirements.length === 0 ? (
              <EmptyState title="No requirements yet" description="Until a job says what it needs, nobody in it can be assessed." />
            ) : (
              <ul className="divide-y divide-slate-200">
                {profile.data.requirements.map((requirement) => (
                  <li key={requirement.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
                    <span className="min-w-0">
                      <span className="block font-medium text-slate-900">{requirement.competency.name}</span>
                      <span className="block text-xs text-slate-500">
                        {requirement.competency.category} · {requirement.competency.scaleName}
                        {!requirement.isMandatory && ' · optional'}
                        {requirement.weight !== null && ` · priority ${requirement.weight}`}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-sm text-slate-700">
                        Required <span className="font-medium text-slate-900">{requirement.requiredLevel}{requirement.requiredLevelLabel ? ` · ${requirement.requiredLevelLabel}` : ''}</span>
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => remove(requirement)}>Remove</Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Add or update a requirement" description="Setting a competency that is already listed updates it." />
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-4">
              <Select
                label="Competency"
                options={(competencies.data?.data ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.category.name})` }))}
                placeholder="Choose a competency"
                value={competencyId}
                onChange={(e) => { setCompetencyId(e.target.value); setRequiredLevel(''); }}
              />
              <Select
                label="Required level"
                options={(chosen?.scale.levels ?? []).map((l) => ({ value: String(l.level), label: `${l.level} · ${l.label}` }))}
                placeholder={chosen ? 'Choose a level' : 'Choose a competency first'}
                value={requiredLevel}
                onChange={(e) => setRequiredLevel(e.target.value)}
                disabled={!chosen}
              />
              <Input label="Priority" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} hint="Optional. A priority, not a percentage — these need not add up to 100." />
              <div className="flex items-end justify-between gap-3">
                <Checkbox label="Mandatory" checked={isMandatory} onChange={(e) => setIsMandatory(e.target.checked)} />
                <Button onClick={add} loading={m.setRequirement.isPending} disabled={!competencyId || !requiredLevel}>Save</Button>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
