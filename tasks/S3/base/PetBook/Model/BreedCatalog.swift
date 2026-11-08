//
//  BreedCatalog.swift
//  PetBook
//
//  品种目录（前端写死，对齐 PRD §10 已拍板决策 + 2026-05-28 乔布斯官方核对修订）。
//  - 狗：HDB 白名单 + 合法非白名单(常见大型犬) + Part 2 受管制 + Part 1 禁养
//    + Singapore Special + Other 兜底，每条带 HDBComplianceStatus，参与 onboarding 实时合规反馈。
//  - 猫：常见 SG 猫品种 + 本地混种 + 其他兜底，纯档案用途，不带任何合规标记。
//
//  数据为客户端常量（PRD §10：列表不常变，无需 S3/CloudFront 远程下发）。
//  ⚠️ HDB 白名单 61 条来自 NParks/AVS 官方规则 + Kohepets/Pretty Pets 第三方交叉验证；
//     官方原始 PDF（.ashx）当前 404，未能逐字核对。上线前需手开 NParks PDF 比对以下「待核」名：
//     Bohemian Terrier(Cesky) vs Czech Terrier（疑同一犬，可能重复计数）、Chinese Temple Dog、
//     Hairless Dog、Small English Terrier / Toy Terrier / Small Spitz / Small Continental Spaniel（旧式 FCI 分类名）。
//

import Foundation

// MARK: - HDB 合规分类（仅狗用；猫品种不带此标记）

enum HDBComplianceStatus: String, Codable, Hashable, CaseIterable {
    case hdbApproved          // HDB 白名单内（小型犬，肩高 ≤55cm）
    case notHDBApproved       // 新加坡合法、可养于 condo/landed，但 HDB 不允许，且非 Specified（如 Labrador/Golden）
    case specifiedRestricted  // Specified Dog Part 2：可养但需保险/口套/牵引，HDB 一律不可
    case prohibited           // Specified Dog Part 1：新加坡禁养
    case adoreEligible        // 非白名单但可走 Project ADORE（Singapore Special / 本地混种）
    case unknownMixed         // Other / Not sure 兜底
}

// MARK: - 狗品种条目

struct DogBreedOption: Identifiable, Hashable {
    let name: String
    let status: HDBComplianceStatus
    var id: String { name }
}

// MARK: - 目录

enum BreedCatalog {

    /// 狗品种列表。排序（乔布斯建议）：兜底置顶 → 合法非白名单常见犬（expat 高频命中）
    /// → HDB 白名单 → Part 2 受管制 → Part 1 禁养。各组内徽章自带分类标识。
    static let dogBreeds: [DogBreedOption] = {
        // 兜底（置顶）
        let fallback: [DogBreedOption] = [
            .init(name: "Singapore Special / Local Mixed", status: .adoreEligible),
            .init(name: "Other / Not sure", status: .unknownMixed),
        ]

        // 合法非白名单常见大型/中型犬（P0 expat 狗主高频）。按 SG 热度排序。
        // 仅收录乔布斯逐一核实过「合法 + 非白名单 + 非 Specified」的品种，可按需扩充（扩时须逐一核 Specified 状态）。
        let notHDBApproved: [String] = [
            "Labrador Retriever", "Golden Retriever", "Siberian Husky",
            "Border Collie", "Beagle", "Corgi", "Samoyed",
            "Shiba Inu", "Standard Poodle",
        ]

        // HDB 白名单 61 条（NParks《Housing & Development (Animals) Rules 2024》，含待核名，详见文件头注释）
        let hdbApproved: [String] = [
            "Affenpinscher", "Australian Silky Terrier", "Australian Terrier",
            "Bichon Frise", "Bohemian Terrier (Cesky)", "Bolognese",
            "Border Terrier", "Boston Terrier", "Brussels Griffon",
            "Bichon Havanese (Havanese)", "Cairn Terrier",
            "Cavalier King Charles Spaniel", "Chihuahua", "Chinese Crested Dog",
            "Chinese Imperial Chin", "Chinese Temple Dog", "Coton de Tulear",
            "Czech Terrier", "Dachshund (Miniature)", "Dandie Dinmont Terrier",
            "English Toy Spaniel", "German Hunting Terrier", "Griffon Belge",
            "Griffon Brabancon", "Hairless Dog", "Italian Greyhound",
            "Jack Russell Terrier", "Japanese Spaniel (Chin)", "Japanese Spitz",
            "Lakeland Terrier", "Lhasa Apso", "Little Lion Dog (Löwchen)",
            "Maltese", "Manchester Terrier", "Miniature Pinscher",
            "Miniature Schnauzer", "Norfolk Terrier", "Norwich Terrier",
            "Papillon", "Pekingese", "Pomeranian",
            "Poodle (Toy or Miniature)", "Pug", "Schipperke",
            "Scottish Terrier", "Sealyham Terrier", "Shetland Sheepdog",
            "Shih Tzu", "Silky Terrier", "Small Continental Spaniel",
            "Small English Terrier", "Small Spitz", "Smooth Fox Terrier",
            "Tibetan Spaniel", "Toy Fox Terrier", "Toy Terrier",
            "Volpino Italiano", "Welsh Terrier", "West Highland White Terrier",
            "Wire-Haired Fox Terrier", "Yorkshire Terrier",
        ]

        // Specified Dog Part 2 — 可养须保险/口套/牵引，HDB 一律不可（Mastiffs 大类拆为常见三条便于搜索）
        let specifiedRestricted: [String] = [
            "Bull Terrier", "Doberman Pinscher", "Rottweiler",
            "German Shepherd Dog", "Belgian Shepherd Dog",
            "East European Shepherd Dog", "Bull Mastiff",
            "Cane Corso", "Dogue de Bordeaux",
        ]

        // Specified Dog Part 1 — 新加坡禁养
        let prohibited: [String] = [
            "Pit Bull", "American Staffordshire Terrier",
            "Staffordshire Bull Terrier", "American Bulldog", "Akita",
            "Neapolitan Mastiff", "Tosa (Japanese Tosa)", "Dogo Argentino",
            "Fila Brasileiro", "Boerboel", "Perro de Presa Canario",
        ]

        return fallback
            + notHDBApproved.map { .init(name: $0, status: .notHDBApproved) }
            + hdbApproved.map { .init(name: $0, status: .hdbApproved) }
            + specifiedRestricted.map { .init(name: $0, status: .specifiedRestricted) }
            + prohibited.map { .init(name: $0, status: .prohibited) }
    }()

    static var dogBreedNames: [String] { dogBreeds.map(\.name) }

    /// 按品种名查 HDB 合规分类；未命中（如 mock 旧自由文本）返回 nil。
    static func dogStatus(for name: String) -> HDBComplianceStatus? {
        dogBreeds.first { $0.name == name }?.status
    }

    /// 猫品种列表（纯档案，无合规标记）。本地/常见置顶 → 长尾 → 兜底置底（乔布斯核对顺序）。
    static let catBreeds: [String] = [
        "Domestic Shorthair", "Domestic Longhair", "Mixed / Local",
        "Singapura", "British Shorthair", "American Shorthair",
        "Ragdoll", "Persian", "Maine Coon",
        "Scottish Fold", "Munchkin", "Bengal",
        "Siamese", "British Longhair", "Exotic Shorthair",
        "Russian Blue", "Sphynx", "Abyssinian",
        "Norwegian Forest Cat", "Birman", "Burmese",
        "Oriental Shorthair", "Other / Not sure",
    ]
}
