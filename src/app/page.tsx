import type { Metadata } from 'next'

import { LandingNav } from '@/components/landing/nav'
import { Hero } from '@/components/landing/hero'
import { FeaturesGrid } from '@/components/landing/features-grid'
import { HowItWorks } from '@/components/landing/how-it-works'
import { FeatureSpotlight } from '@/components/landing/feature-spotlight'
import { FAQ } from '@/components/landing/faq'
import { OpenSource } from '@/components/landing/open-source'
import { CtaBanner } from '@/components/landing/cta-banner'
import { Footer } from '@/components/landing/footer'
import { InboxMock } from '@/components/landing/mock/inbox-mock'
import { PipelineMock } from '@/components/landing/mock/pipeline-mock'
import { AutomationMock } from '@/components/landing/mock/automation-mock'
import { AnalyticsMock } from '@/components/landing/mock/analytics-mock'
import { JsonLd } from '@/components/seo/json-ld'
import { landingPageLd } from '@/lib/seo/structured-data'
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from '@/lib/seo/site-config'

// Landing-specific metadata. Most fields are inherited from the root
// layout's metadata — we override title (so the hero copy shows in
// SERPs / tab titles) and set an explicit canonical for "/" to avoid
// trailing-slash duplicate-content signals.
export const metadata: Metadata = {
  title: {
    absolute: `${SITE_NAME} — ${SITE_TAGLINE}`,
  },
  description: SITE_DESCRIPTION,
  alternates: {
    canonical: '/',
  },
}

// Marketing landing. Visible at / for everyone (auth redirect that
// used to send anonymous visitors to /login was removed). Authed users
// still see this page; the nav swaps its CTA to "Go to Dashboard".
export default function LandingPage() {
  return (
    <div className="bg-slate-950 text-slate-100">
      {/* JSON-LD — WebSite, Organization, SoftwareApplication, FAQPage.
          Emitted before any visible content so crawlers hit it first. */}
      <JsonLd data={landingPageLd()} />
      <LandingNav />
      <main>
        <Hero />

        <FeaturesGrid />

        <FeatureSpotlight
          anchorId="inbox"
          eyebrow="Shared inbox"
          title="Never drop a WhatsApp conversation again"
          body="Your whole team works from one inbox. Conversations can be assigned, tagged, and handed off without losing context. Real-time updates so two agents never reply to the same thread at the same time."
          bullets={[
            'Assign threads to specific agents or round-robin across the team',
            'Internal notes that only your team sees',
            'Unread indicators so urgent replies never slip through',
            'Deep-link into any conversation from the dashboard',
          ]}
          visual={<InboxMock />}
        />

        <HowItWorks />

        <FeatureSpotlight
          anchorId="automations"
          eyebrow="No-code automations"
          title="Automate the repetitive, focus on the humans"
          body="Build flows that react to WhatsApp events: welcome new contacts, chase unanswered replies, route leads by keyword. Conditions, waits, tags, deals — all with a visual builder that feels like Figma for workflows."
          bullets={[
            'Triggers for new messages, new contacts, tag changes, keywords, schedules',
            'Actions: send message / template, add tag, create deal, webhook, and more',
            'Conditional branches and wait steps for human-time delays',
            'Per-run logs so you always know what ran and why',
          ]}
          reverse
          visual={<AutomationMock />}
        />

        <FeatureSpotlight
          anchorId="pipelines"
          eyebrow="Sales pipelines"
          title="Turn conversations into revenue"
          body="Drag deals through custom stages, link them to contacts, and see exactly where revenue is getting stuck. Every deal keeps its WhatsApp thread one click away — so context never gets lost on a handoff."
          bullets={[
            'Unlimited pipelines and stages',
            'Kanban board with drag-and-drop',
            'Deal value totals per stage and pipeline-wide',
            'Linked contacts, conversations, and notes per deal',
          ]}
          visual={<PipelineMock />}
        />

        <FeatureSpotlight
          anchorId="analytics"
          eyebrow="Real-time analytics"
          title="See what is actually working"
          body="Response times, daily volume, pipeline value, and a cross-module activity feed. The dashboard tells you where attention is needed without you building a single chart."
          bullets={[
            'Active conversations, new contacts, open deal value — live',
            'Conversations over time for 7, 30, or 90 days',
            'Average first-response time by weekday against your target',
            'Activity feed merged across messages, deals, broadcasts, automations',
          ]}
          reverse
          visual={<AnalyticsMock />}
        />

        <OpenSource />

        <FAQ />

        <CtaBanner />
      </main>
      <Footer />
    </div>
  )
}
