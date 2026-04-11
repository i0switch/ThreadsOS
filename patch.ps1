$root = (Get-Location).Path

function ReadFile($rel) {
    [System.IO.File]::ReadAllText((Join-Path $root $rel), [System.Text.Encoding]::UTF8)
}
function WriteFile($rel, $content) {
    [System.IO.File]::WriteAllText((Join-Path $root $rel), $content, [System.Text.Encoding]::UTF8)
    Write-Host "Wrote: $rel"
}

# ─── 1. department-execution/index.ts ───────────────────────────────────────
$de = ReadFile "src\services\department-execution\index.ts"

# 1a. Add departmentSummaries to schema import
$de = $de -replace @"
import \{
  contentSlots,
  departmentRuns,
"@, @"
import {
  contentSlots,
  departmentRuns,
  departmentSummaries,
"@

# 1b. Replace private getLastRun with getLastRun + getLatestDepartmentSummary
$de = $de -replace @"
  private getLastRun\(department: DepartmentName\): string \| null \{
    const last = db
      \.select\(\)
      \.from\(departmentRuns\)
      \.where\(eq\(departmentRuns\.department, department\)\)
      \.orderBy\(desc\(departmentRuns\.createdAt\)\)
      \.limit\(1\)
      \.get\(\);
    return last\?\.createdAt \?\? null;
  \}
"@, @"
  private getLastRun(department: DepartmentName): string | null {
    const last = db
      .select()
      .from(departmentRuns)
      .where(eq(departmentRuns.department, department))
      .orderBy(desc(departmentRuns.createdAt))
      .limit(1)
      .get();
    return last?.createdAt ?? null;
  }

  private getLatestDepartmentSummary(department: DepartmentName): string | null {
    const row = db
      .select()
      .from(departmentSummaries)
      .where(eq(departmentSummaries.department, department))
      .orderBy(desc(departmentSummaries.updatedAt))
      .limit(1)
      .get();
    return row?.content ?? null;
  }
"@

Write-Host "de length after helper: $($de.Length)"
WriteFile "src\services\department-execution\index.ts" $de