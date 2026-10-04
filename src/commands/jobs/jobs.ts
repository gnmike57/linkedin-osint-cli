import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';

export const jobsViewCommand: CommandDefinition = {
  name: 'jobs_view',
  group: 'jobs',
  subcommand: 'view',
  description: 'View job posting details by job ID',
  examples: ['linkedin jobs view 3456789012'],

  inputSchema: z.object({
    job_id: z.string().describe('Job posting ID'),
  }),

  cliMappings: {
    args: [{ field: 'job_id', name: 'job-id', required: true }],
  },

  handler: async (input, client) => {
    return client.get(`/jobs/jobPostings/${input.job_id}`, {
      decorationId: 'com.linkedin.voyager.deco.jobs.web.shared.WebLightJobPosting-23',
    });
  },
};

export const jobsSkillsCommand: CommandDefinition = {
  name: 'jobs_skills',
  group: 'jobs',
  subcommand: 'skills',
  description: 'Get skill match insights for a job posting',
  examples: ['linkedin jobs skills 3456789012'],

  inputSchema: z.object({
    job_id: z.string().describe('Job posting ID'),
  }),

  cliMappings: {
    args: [{ field: 'job_id', name: 'job-id', required: true }],
  },

  handler: async (input, client) => {
    const urn = encodeURIComponent(`urn:li:fsd_jobSkillMatchInsight:${input.job_id}`);
    return client.get(`/voyagerAssessmentsDashJobSkillMatchInsight/${urn}`, {
      decorationId: 'com.linkedin.voyager.dash.deco.assessments.FullJobSkillMatchInsight-17',
    });
  },
};

export const jobsCommands = [
  jobsViewCommand,
  jobsSkillsCommand,
];
