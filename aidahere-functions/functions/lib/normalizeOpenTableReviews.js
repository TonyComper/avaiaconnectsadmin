function normalizeOpenTableReviews(reviews = []) {
  if (!Array.isArray(reviews)) return [];

  return reviews.map((r) => {
    const overallRating = r?.rating?.overall ?? null;

    return {
      source: "opentable",
      reviewId: r?.id || null,

      author: r?.user?.name || "Anonymous",
      authorLocation: r?.user?.location || null,
      authorReviewCount: r?.user?.number_of_reviews || null,
      isVip: !!r?.user?.vip,

      rating: overallRating,
      ratingsBreakdown: {
        food: r?.rating?.food ?? null,
        service: r?.rating?.service ?? null,
        ambience: r?.rating?.ambience ?? null,
        value: r?.rating?.value ?? null,
        noise: r?.rating?.noise ?? null,
      },

      text: r?.content || "",

      date: r?.submitted_at || r?.dined_at || null,
      dinedAt: r?.dined_at || null,

      hasImages: Array.isArray(r?.images) && r.images.length > 0,

      platformMeta: {
        opentableId: r?.id || null,
      },
    };
  });
}

module.exports = { normalizeOpenTableReviews };