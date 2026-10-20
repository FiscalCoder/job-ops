/** Same shape as Job Ops' design resume (Reactive Resume v4), fake values. */
export const fakeDesignResume = {
  basics: {
    name: "T.Candidate",
    email: "test@example.com",
    phone: "9876543210",
    website: { url: "https://example.dev", label: "example.dev" },
  },
  sections: {
    summary: { hidden: false, content: "<p>Full-stack engineer.</p>" },
    skills: {
      items: [
        { hidden: false, name: "Frontend", keywords: ["React", "TypeScript"] },
        { hidden: true, name: "Hidden", keywords: ["COBOL"] },
      ],
    },
    profiles: {
      items: [
        {
          hidden: false,
          network: "LinkedIn",
          website: { url: "https://linkedin.com/in/test" },
        },
        {
          hidden: false,
          network: "GitHub",
          website: { url: "https://github.com/test" },
        },
      ],
    },
    experience: {
      items: [
        {
          hidden: false,
          company: "Acme",
          position: "Senior Engineer",
          location: "Remote",
          period: "September 2023 - Present",
          description: "<p>Built things</p>",
        },
        {
          hidden: false,
          company: "Beta",
          position: "Engineer",
          location: "Pune",
          period: "January 2020 - August 2023",
          description: "Shipped things",
        },
        {
          hidden: true,
          company: "Hidden Co",
          position: "Intern",
          period: "2019",
          description: "",
        },
      ],
    },
    education: {
      items: [
        {
          hidden: false,
          school: "Some Institute of Technology",
          degree: "B.Tech",
          area: "Computer Science",
          period: "2019",
        },
        {
          hidden: false,
          school: "Some School",
          degree: "XII Science",
          area: "PCM",
          period: "2015",
        },
      ],
    },
  },
};
